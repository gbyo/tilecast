package plugins

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"image"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/durable"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/outbound"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Remote feed images (docs/plugin-feeds.md#remote-images). A publication
// only queues an import; a worker fetches the image after the commit
// through the field's connection, over HTTPS only, checks it, stores one
// private plugin asset per plugin and SHA-256, and attaches it only while
// the publication revision that asked for it is still current.

// Feed image bounds and timings.
const (
	feedImageMaxBytes  = 8 << 20
	feedImageMaxSide   = 8192
	feedImageMaxPixels = 40_000_000
	feedImageTimeout   = 30 * time.Second
	feedImageLease     = 2 * time.Minute
	feedImageBatch     = 10
	feedImageAttempts  = 5
	feedImageRetryBase = 30 * time.Second
	feedImageRetryMax  = 30 * time.Minute
	// FeedImageQuotaBytes bounds the private feed images of one plugin.
	FeedImageQuotaBytes = 512 << 20
	// feedAssetGrace is how long an image no current record names is kept
	// before the host discards it.
	feedAssetGrace = 24 * time.Hour
)

// Stable codes of a failed image import.
const (
	ImageHTTPRefused   = "http_refused"
	ImageAuthRequired  = "auth_required"
	ImageFetchFailed   = "fetch_failed"
	ImageInvalid       = "invalid_image"
	ImageTooLarge      = "image_too_large"
	ImageProcessing    = "processing_failed"
	ImageQuotaExceeded = "quota_exceeded"
)

var imageQueue = durable.Queue{Table: "plugin_feed_image_imports"}

// queueFeedImages enqueues the imports a publication needs, in the
// publication's transaction. The fetch happens after the commit.
func (s *Service) queueFeedImages(ctx context.Context, tx pgx.Tx, feed plugin.Feed, datasetID uuid.UUID, revision int64, records []FeedRecordInput, connections map[string]uuid.UUID, queued map[string]bool) error {
	now := s.clock.Now().UTC()
	for _, record := range records {
		for _, field := range feed.Fields {
			if field.Image == nil || !queued[record.ID+"\x00"+field.Key] {
				continue
			}
			address, _ := record.Values[field.Key].(string)
			if _, err := tx.Exec(ctx, `INSERT INTO plugin_feed_image_imports(id,dataset_id,revision,record_id,field_key,url,connection_id,due_at)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8)
				ON CONFLICT (dataset_id,record_id,field_key) DO UPDATE SET id=EXCLUDED.id,revision=EXCLUDED.revision,url=EXCLUDED.url,
				connection_id=EXCLUDED.connection_id,due_at=EXCLUDED.due_at,attempts=0,claim_token=NULL,claimed_until=NULL,last_error=NULL`,
				uuid.New(), datasetID, revision, record.ID, field.Key, address, connections[field.Image.Connection], now); err != nil {
				return err
			}
		}
	}
	return nil
}

type imageJob struct {
	claim      durable.Claim
	datasetID  uuid.UUID
	pluginID   string
	feedID     string
	revision   int64
	recordID   string
	field      string
	address    string
	connection uuid.UUID
}

// RunFeedImageImports fetches due image imports and reports how many ran.
func (s *Service) RunFeedImageImports(ctx context.Context) (int, error) {
	if s.attachments == nil {
		return 0, nil
	}
	claims, err := imageQueue.Claim(ctx, s.db, s.clock.Now(), feedImageLease, feedImageBatch, durable.Filter{})
	if err != nil {
		return 0, err
	}
	for _, claim := range claims {
		job := imageJob{claim: claim}
		err := s.db.QueryRow(ctx, `SELECT i.dataset_id,d.plugin_id,d.feed_id,i.revision,i.record_id,i.field_key,i.url,i.connection_id
			FROM plugin_feed_image_imports i JOIN plugin_feed_datasets d ON d.id=i.dataset_id WHERE i.id=$1 AND i.claim_token=$2`, claim.ID, claim.Token).
			Scan(&job.datasetID, &job.pluginID, &job.feedID, &job.revision, &job.recordID, &job.field, &job.address, &job.connection)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return 0, err
		}
		if err := s.importFeedImage(ctx, job); err != nil && ctx.Err() != nil {
			return 0, err
		}
	}
	return len(claims), nil
}

func (s *Service) importFeedImage(ctx context.Context, job imageJob) error {
	current, err := s.imageJobCurrent(ctx, s.db, job)
	if err != nil {
		return err
	}
	if !current {
		// A newer publication replaced the record, the field, or the
		// revision: this import attaches nothing.
		_, err := imageQueue.Complete(ctx, s.db, job.claim)
		return err
	}
	data, code, retry := s.fetchFeedImage(ctx, job)
	if code == "" {
		code, retry = checkFeedImage(data)
	}
	var asset uuid.UUID
	if code == "" {
		asset, code, retry = s.storeFeedImage(ctx, job.pluginID, data)
	}
	if code != "" {
		return s.failFeedImage(ctx, job, code, retry)
	}
	var changes []manifestchanges.Change
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM plugin_feed_datasets WHERE id=$1 FOR UPDATE`, job.datasetID); err != nil {
			return err
		}
		current, err := s.imageJobCurrent(ctx, tx, job)
		if err != nil || !current {
			if err == nil {
				_, err = imageQueue.Complete(ctx, tx, job.claim)
			}
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO plugin_feed_assets(dataset_id,record_id,field_key,asset_id,source_url) VALUES($1,$2,$3,$4,$5)
			ON CONFLICT (dataset_id,record_id,field_key) DO UPDATE SET asset_id=EXCLUDED.asset_id,source_url=EXCLUDED.source_url`,
			job.datasetID, job.recordID, job.field, asset, job.address); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE plugin_feed_blobs SET orphaned_at=NULL WHERE asset_id=$1`, asset); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_feed_image_failures WHERE dataset_id=$1 AND record_id=$2 AND field_key=$3`, job.datasetID, job.recordID, job.field); err != nil {
			return err
		}
		if _, err := imageQueue.Complete(ctx, tx, job.claim); err != nil {
			return err
		}
		changes, err = s.projectFeedDataset(ctx, tx, job.datasetID, "plugin.feed.image_imported")
		return err
	})
	if err != nil {
		return err
	}
	s.notifyDataSources(changes)
	return nil
}

// imageJobCurrent reports whether the import still belongs to the current
// revision and the record still names the same URL.
func (s *Service) imageJobCurrent(ctx context.Context, q queryer, job imageJob) (bool, error) {
	var revision int64
	var address *string
	err := q.QueryRow(ctx, `SELECT d.revision,r.upstream->>$3 FROM plugin_feed_datasets d
		LEFT JOIN plugin_feed_records r ON r.dataset_id=d.id AND r.record_id=$2 WHERE d.id=$1`, job.datasetID, job.recordID, job.field).Scan(&revision, &address)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return revision == job.revision && address != nil && *address == job.address, nil
}

// fetchFeedImage fetches the image through the connection: HTTPS only,
// even when the connection allows plain HTTP for other requests; the
// connection's origins, addresses, and consents; the OAuth bearer of an
// oauth2 connection; and a bounded body. It returns a stable code on
// failure and whether a retry can help.
func (s *Service) fetchFeedImage(ctx context.Context, job imageJob) ([]byte, string, bool) {
	target, err := url.Parse(job.address)
	if err != nil || !strings.EqualFold(target.Scheme, plugin.SchemeHTTPS) {
		return nil, ImageHTTPRefused, false
	}
	connection, refusal := s.resolveConnection(ctx, job.pluginID, job.connection)
	if refusal != nil {
		return nil, ImageFetchFailed, false
	}
	target, refusal = connection.requestURL(job.address)
	if refusal != nil {
		return nil, ImageFetchFailed, false
	}
	headers := []outbound.RequestHeader{{Name: "Accept", Value: "image/*"}}
	if connection.declaration.IsOAuth() {
		bearer, refusal := s.bearerHeader(ctx, connection, nil)
		if refusal != nil {
			return nil, ImageAuthRequired, refusal.Code == CodeOAuthRefreshFailed
		}
		headers = append(headers, bearer)
	}
	policy := connection.policy()
	policy.PlainHTTP = false
	policy.MaxResponseBytes = feedImageMaxBytes
	policy.Timeout = feedImageTimeout
	response, err := s.outboundEngine().Do(ctx, policy, outbound.Request{Method: http.MethodGet, URL: target, Headers: headers})
	if err != nil {
		switch outbound.FailureCode(err) {
		case outbound.CodeResponseTooLarge:
			return nil, ImageTooLarge, false
		case outbound.CodePlainHTTPRefused:
			return nil, ImageHTTPRefused, false
		case outbound.CodeOriginNotAllowed, outbound.CodePrivateNetworkRefused, outbound.CodeDNSAddressRefused,
			outbound.CodeRedirectRefused, outbound.CodeRequestInvalid:
			// A policy refusal: the same request fails again.
			return nil, ImageFetchFailed, false
		}
		return nil, ImageFetchFailed, true
	}
	switch {
	case response.Status == http.StatusUnauthorized || response.Status == http.StatusForbidden:
		return nil, ImageAuthRequired, false
	case response.Status >= 500 || response.Status == http.StatusTooManyRequests || response.Status == http.StatusRequestTimeout:
		return nil, ImageFetchFailed, true
	case response.Status != http.StatusOK:
		return nil, ImageFetchFailed, false
	}
	return response.Body, "", false
}

// checkFeedImage sniffs the bytes, never the Content-Type, and reads only
// the image header to bound the dimensions before anything decodes pixels.
func checkFeedImage(data []byte) (string, bool) {
	if len(data) == 0 {
		return ImageInvalid, false
	}
	header := data
	if len(header) > 512 {
		header = header[:512]
	}
	detected, err := media.DetectType(header)
	if err != nil || detected.AssetType != "image" {
		return ImageInvalid, false
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return ImageInvalid, false
	}
	if config.Width > feedImageMaxSide || config.Height > feedImageMaxSide || config.Width*config.Height > feedImageMaxPixels {
		return ImageTooLarge, false
	}
	if _, err := media.InspectImage(bytes.NewReader(data)); err != nil {
		return ImageInvalid, false
	}
	return "", false
}

// storeFeedImage returns the plugin's asset for these bytes: an existing
// one with the same SHA-256 of the same plugin, or a new private asset
// within the plugin's quota.
func (s *Service) storeFeedImage(ctx context.Context, pluginID string, data []byte) (uuid.UUID, string, bool) {
	sum := sha256.Sum256(data)
	var existing uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT b.asset_id FROM plugin_feed_blobs b JOIN assets a ON a.id=b.asset_id AND a.deleted_at IS NULL
		WHERE b.plugin_id=$1 AND b.sha256=$2`, pluginID, sum[:]).Scan(&existing)
	if err == nil {
		return existing, "", false
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ImageProcessing, true
	}
	var used int64
	if err := s.db.QueryRow(ctx, `SELECT COALESCE(SUM(b.byte_size),0) FROM plugin_feed_blobs b JOIN assets a ON a.id=b.asset_id AND a.deleted_at IS NULL
		WHERE b.plugin_id=$1`, pluginID).Scan(&used); err != nil {
		return uuid.Nil, ImageProcessing, true
	}
	if used+int64(len(data)) > FeedImageQuotaBytes {
		return uuid.Nil, ImageQuotaExceeded, false
	}
	asset, err := s.attachments.IngestPluginAsset(ctx, media.PluginAssetInput{PluginID: pluginID, Filename: "feed-image", Data: data,
		AuditAction: "plugin.feed.image_imported"})
	if err != nil {
		return uuid.Nil, ImageProcessing, false
	}
	// A deleted blob row of the same bytes (its asset was discarded) gives
	// way to the new asset.
	if _, err := s.db.Exec(ctx, `INSERT INTO plugin_feed_blobs(plugin_id,sha256,asset_id,byte_size) VALUES($1,$2,$3,$4)
		ON CONFLICT (plugin_id,sha256) DO UPDATE SET asset_id=EXCLUDED.asset_id,byte_size=EXCLUDED.byte_size,orphaned_at=NULL,created_at=now()`,
		pluginID, sum[:], asset.ID, len(data)); err != nil {
		return uuid.Nil, ImageProcessing, true
	}
	return asset.ID, "", false
}

// failFeedImage records a failed import: a retry with backoff when one can
// help, otherwise an attention item while the field stays empty.
func (s *Service) failFeedImage(ctx context.Context, job imageJob, code string, retry bool) error {
	if retry && job.claim.Attempt < feedImageAttempts {
		_, err := imageQueue.Retry(ctx, s.db, job.claim, s.clock.Now().Add(durable.Backoff(job.claim.Attempt, feedImageRetryBase, feedImageRetryMax)), code)
		return err
	}
	s.logger.Info("plugin feed image not imported", "plugin", job.pluginID, "feed", job.feedID, "dataset", job.datasetID, "failure", code)
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		current, err := s.imageJobCurrent(ctx, tx, job)
		if err != nil {
			return err
		}
		if current {
			if _, err := tx.Exec(ctx, `INSERT INTO plugin_feed_image_failures(dataset_id,record_id,field_key,code,failed_at) VALUES($1,$2,$3,$4,$5)
				ON CONFLICT (dataset_id,record_id,field_key) DO UPDATE SET code=EXCLUDED.code,failed_at=EXCLUDED.failed_at`,
				job.datasetID, job.recordID, job.field, code, s.clock.Now().UTC()); err != nil {
				return err
			}
		}
		_, err = imageQueue.Complete(ctx, tx, job.claim)
		return err
	})
}

// CollectFeedAssets runs the discard rule: an image that no current record
// names is orphaned; 24 hours later the host soft-deletes the private asset
// through the media lifecycle. A record that names it again first cancels
// the discard. It reports how many assets were discarded.
func (s *Service) CollectFeedAssets(ctx context.Context) (int, error) {
	if s.attachments == nil {
		return 0, nil
	}
	now := s.clock.Now().UTC()
	if _, err := s.db.Exec(ctx, `UPDATE plugin_feed_blobs b SET orphaned_at=$1 WHERE orphaned_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM plugin_feed_assets f WHERE f.asset_id=b.asset_id)`, now); err != nil {
		return 0, err
	}
	if _, err := s.db.Exec(ctx, `UPDATE plugin_feed_blobs b SET orphaned_at=NULL WHERE orphaned_at IS NOT NULL
		AND EXISTS (SELECT 1 FROM plugin_feed_assets f WHERE f.asset_id=b.asset_id)`); err != nil {
		return 0, err
	}
	rows, err := s.db.Query(ctx, `SELECT plugin_id,asset_id FROM plugin_feed_blobs WHERE orphaned_at<=$1`, now.Add(-feedAssetGrace))
	if err != nil {
		return 0, err
	}
	type orphan struct {
		pluginID string
		asset    uuid.UUID
	}
	orphans, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (orphan, error) {
		var item orphan
		return item, row.Scan(&item.pluginID, &item.asset)
	})
	if err != nil {
		return 0, err
	}
	discarded := 0
	for _, item := range orphans {
		tag, err := s.db.Exec(ctx, `DELETE FROM plugin_feed_blobs b WHERE asset_id=$1 AND orphaned_at<=$2
			AND NOT EXISTS (SELECT 1 FROM plugin_feed_assets f WHERE f.asset_id=b.asset_id)`, item.asset, now.Add(-feedAssetGrace))
		if err != nil {
			return discarded, err
		}
		if tag.RowsAffected() == 0 {
			continue
		}
		if err := s.attachments.SoftDeletePrivateAsset(ctx, item.pluginID, item.asset); err != nil {
			return discarded, err
		}
		discarded++
	}
	return discarded, nil
}
