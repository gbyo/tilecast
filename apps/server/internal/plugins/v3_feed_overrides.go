package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Studio's generic view of feed datasets and the operator overrides of
// their records. Plugins write no editor of their own.

// FeedDatasetDocument is one dataset as Studio lists it.
type FeedDatasetDocument struct {
	ID           uuid.UUID  `json:"id"`
	Feed         string     `json:"feed"`
	FeedVersion  int        `json:"feedVersion"`
	Title        string     `json:"title"`
	Provider     string     `json:"provider"`
	Name         string     `json:"name"`
	InstanceID   *uuid.UUID `json:"instanceId,omitempty"`
	Revision     int64      `json:"revision"`
	Records      int        `json:"records"`
	PublishedAt  *time.Time `json:"publishedAt,omitempty"`
	ValidUntil   *time.Time `json:"validUntil,omitempty"`
	Stale        bool       `json:"stale"`
	ImageIssues  int        `json:"imageIssues"`
	Overrides    int        `json:"overrides"`
	WidgetsUsing int        `json:"widgetsUsing"`
}

// FeedFieldDocument is one declared field as Studio shows it.
type FeedFieldDocument struct {
	Key       string                      `json:"key"`
	Label     string                      `json:"label"`
	Control   string                      `json:"control"`
	Type      string                      `json:"type"`
	Override  string                      `json:"override"`
	Personal  bool                        `json:"personal"`
	Image     bool                        `json:"image"`
	Required  bool                        `json:"required"`
	MaxLength int                         `json:"maxLength,omitempty"`
	Options   []configschema.SelectOption `json:"options,omitempty"`
}

// FeedRecordsDocument is one page of records of a dataset.
type FeedRecordsDocument struct {
	Dataset FeedDatasetDocument  `json:"dataset"`
	Fields  []FeedFieldDocument  `json:"fields"`
	Items   []FeedRecordDocument `json:"items"`
	Total   int                  `json:"total"`
}

func (s *Service) feedDatasetDocument(ctx context.Context, q queryer, hosted hostedPlugin, dataset feedDataset) (FeedDatasetDocument, error) {
	feed, _ := hosted.manifest.FeedByID(dataset.feedID)
	document := FeedDatasetDocument{ID: dataset.id, Feed: dataset.feedID, FeedVersion: dataset.version, Title: feed.Title,
		Provider: feed.ProviderID(hosted.manifest.ID), InstanceID: dataset.instanceID, Revision: dataset.revision,
		PublishedAt: dataset.publishedAt, ValidUntil: dataset.validUntil}
	err := q.QueryRow(ctx, `SELECT d.name,
		(SELECT count(*) FROM plugin_feed_records r WHERE r.dataset_id=$1),
		(SELECT count(*) FROM plugin_feed_image_failures f WHERE f.dataset_id=$1),
		(SELECT count(*) FROM plugin_feed_overrides o WHERE o.dataset_id=$1),
		(SELECT count(*) FROM widgets w JOIN assets a ON a.id=w.asset_id AND a.deleted_at IS NULL WHERE w.configuration->>'dataSourceId'=$1::text)
		FROM data_sources d WHERE d.id=$1`, dataset.id).Scan(&document.Name, &document.Records, &document.ImageIssues, &document.Overrides, &document.WidgetsUsing)
	if err != nil {
		return FeedDatasetDocument{}, err
	}
	document.Stale = feedStale(dataset, feed, s.clock.Now())
	return document, nil
}

// feedStale reports a dataset whose last publication is older than twice
// the feed's expected refresh interval, or that has none yet.
func feedStale(dataset feedDataset, feed plugin.Feed, now time.Time) bool {
	return dataset.publishedAt == nil || now.Sub(*dataset.publishedAt) > 2*feed.ExpectedRefresh()
}

// ListFeedDatasets lists a plugin's feed datasets.
func (s *Service) ListFeedDatasets(ctx context.Context, pluginID string) ([]FeedDatasetDocument, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 || len(hosted.manifest.Feeds) == 0 {
		return nil, ErrPluginNotFound
	}
	rows, err := s.db.Query(ctx, `SELECT `+feedDatasetColumns+` FROM plugin_feed_datasets WHERE plugin_id=$1 ORDER BY feed_id,created_at,id`, pluginID)
	if err != nil {
		return nil, err
	}
	datasets, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (feedDataset, error) { return scanFeedDataset(row) })
	if err != nil {
		return nil, err
	}
	out := []FeedDatasetDocument{}
	for _, dataset := range datasets {
		if _, ok := hosted.manifest.FeedByID(dataset.feedID); !ok {
			continue
		}
		document, err := s.feedDatasetDocument(ctx, s.db, hosted, dataset)
		if err != nil {
			return nil, err
		}
		out = append(out, document)
	}
	return out, nil
}

func feedNotFound() error {
	return &plugin.APIError{Status: http.StatusNotFound, Code: "plugin_feed_dataset_not_found", Message: "The feed dataset was not found."}
}

func (s *Service) feedDatasetOf(ctx context.Context, q queryer, pluginID string, id uuid.UUID, lock bool) (hostedPlugin, plugin.Feed, feedDataset, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 || len(hosted.manifest.Feeds) == 0 {
		return hostedPlugin{}, plugin.Feed{}, feedDataset{}, ErrPluginNotFound
	}
	query := `SELECT ` + feedDatasetColumns + ` FROM plugin_feed_datasets WHERE id=$1 AND plugin_id=$2`
	if lock {
		query += ` FOR UPDATE`
	}
	dataset, err := scanFeedDataset(q.QueryRow(ctx, query, id, pluginID))
	if errors.Is(err, pgx.ErrNoRows) {
		return hostedPlugin{}, plugin.Feed{}, feedDataset{}, feedNotFound()
	}
	if err != nil {
		return hostedPlugin{}, plugin.Feed{}, feedDataset{}, err
	}
	feed, ok := hosted.manifest.FeedByID(dataset.feedID)
	if !ok {
		return hostedPlugin{}, plugin.Feed{}, feedDataset{}, feedNotFound()
	}
	return hosted, feed, dataset, nil
}

// FeedRecords returns one page of a dataset's records with upstream,
// override, and effective values. Personal values are shown to the
// operators who may read the plugin, as the instance editor does.
func (s *Service) FeedRecords(ctx context.Context, pluginID string, id uuid.UUID, offset, limit int) (FeedRecordsDocument, error) {
	hosted, feed, dataset, err := s.feedDatasetOf(ctx, s.db, pluginID, id, false)
	if err != nil {
		return FeedRecordsDocument{}, err
	}
	document, err := s.feedDatasetDocument(ctx, s.db, hosted, dataset)
	if err != nil {
		return FeedRecordsDocument{}, err
	}
	records, err := s.effectiveRecords(ctx, s.db, feed, id)
	if err != nil {
		return FeedRecordsDocument{}, err
	}
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	total := len(records)
	if offset > total {
		offset = total
	}
	end := min(offset+limit, total)
	return FeedRecordsDocument{Dataset: document, Fields: feedFieldDocuments(feed), Items: records[offset:end], Total: total}, nil
}

func feedFieldDocuments(feed plugin.Feed) []FeedFieldDocument {
	out := make([]FeedFieldDocument, 0, len(feed.Fields))
	for _, field := range feed.Fields {
		out = append(out, FeedFieldDocument{Key: field.Key, Label: field.Label, Control: field.Control, Type: field.DocumentType(),
			Override: field.OverridePolicy(), Personal: field.Personal != nil, Image: field.Image != nil, Required: field.Required,
			MaxLength: field.MaxLength, Options: field.Options})
	}
	return out
}

// SetFeedOverride writes an operator override of one field. The field's
// policy must allow it. The value is validated like the field's upstream
// value. A null value removes the override.
func (s *Service) SetFeedOverride(ctx context.Context, pluginID string, id uuid.UUID, recordID, fieldKey string, value json.RawMessage, userID uuid.UUID) (FeedRecordDocument, error) {
	var parsed any
	if err := json.Unmarshal(value, &parsed); err != nil {
		return FeedRecordDocument{}, feedAPIError(feedInvalid("the override value is not JSON"))
	}
	var result FeedRecordDocument
	var changes []manifestchanges.Change
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		_, feed, dataset, err := s.feedDatasetOf(ctx, tx, pluginID, id, true)
		if err != nil {
			return err
		}
		field, ok := feedField(feed, fieldKey)
		if !ok || field.OverridePolicy() == plugin.OverrideUpstream || field.Image != nil {
			return feedInvalid("field %q takes no override; the publication always wins", fieldKey)
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plugin_feed_records WHERE dataset_id=$1 AND record_id=$2)`, id, recordID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return &plugin.APIError{Status: http.StatusNotFound, Code: "plugin_feed_record_not_found", Message: "The record is no longer in the feed."}
		}
		if parsed == nil {
			if _, err := tx.Exec(ctx, `DELETE FROM plugin_feed_overrides WHERE dataset_id=$1 AND record_id=$2 AND field_key=$3`, id, recordID, fieldKey); err != nil {
				return err
			}
		} else {
			single := field.Field
			single.Required = false
			normalized, err := configschema.Normalize(ctx, []configschema.Field{single}, map[string]any{fieldKey: parsed}, s.configReferences())
			if err != nil {
				return feedInvalid("%v", err)
			}
			encoded, _ := json.Marshal(normalized[fieldKey])
			if _, err := tx.Exec(ctx, `INSERT INTO plugin_feed_overrides(dataset_id,record_id,field_key,value,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)
				ON CONFLICT (dataset_id,record_id,field_key) DO UPDATE SET value=EXCLUDED.value,created_by=EXCLUDED.created_by,updated_at=EXCLUDED.updated_at`,
				id, recordID, fieldKey, encoded, nullableUser(userID), s.clock.Now().UTC()); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM plugin_feed_override_removals WHERE dataset_id=$1 AND record_id=$2 AND field_key=$3`, id, recordID, fieldKey); err != nil {
				return err
			}
		}
		action := "plugin.feed.override_set"
		if parsed == nil {
			action = "plugin.feed.override_cleared"
		}
		if err := s.auditFeed(ctx, tx, action, pluginID, feed, id, userID, map[string]any{"recordId": recordID, "field": fieldKey}); err != nil {
			return err
		}
		if changes, err = s.projectFeedDataset(ctx, tx, dataset.id, action); err != nil {
			return err
		}
		records, err := s.effectiveRecords(ctx, tx, feed, id)
		if err != nil {
			return err
		}
		for _, record := range records {
			if record.ID == recordID {
				result = record
			}
		}
		return nil
	})
	if err != nil {
		return FeedRecordDocument{}, feedAPIError(err)
	}
	s.notifyDataSources(changes)
	return result, nil
}

// feedDatasetsOfInstance handles the datasets of an instance that is being
// deleted. A dataset a Widget still uses blocks the deletion; otherwise the
// dataset and its Data Source go with the instance.
func (s *Service) releaseInstanceFeeds(ctx context.Context, tx pgx.Tx, pluginID string, instanceID uuid.UUID) error {
	rows, err := tx.Query(ctx, `SELECT d.id,ds.name,(SELECT count(*) FROM widgets w JOIN assets a ON a.id=w.asset_id AND a.deleted_at IS NULL
		WHERE w.configuration->>'dataSourceId'=d.id::text) FROM plugin_feed_datasets d JOIN data_sources ds ON ds.id=d.id
		WHERE d.plugin_id=$1 AND d.instance_id=$2 FOR UPDATE OF d`, pluginID, instanceID)
	if err != nil {
		return err
	}
	type dataset struct {
		id    uuid.UUID
		name  string
		using int
	}
	datasets, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (dataset, error) {
		var item dataset
		return item, row.Scan(&item.id, &item.name, &item.using)
	})
	if err != nil {
		return err
	}
	for _, item := range datasets {
		if item.using > 0 {
			return &plugin.APIError{Status: http.StatusConflict, Code: "plugin_instance_in_use",
				Message: "Widgets show this item's data. Remove the Data Source from those Widgets first.",
				Details: map[string]any{"dataSource": item.id, "dataSourceName": item.name, "widgets": item.using}}
		}
	}
	for _, item := range datasets {
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_feed_datasets WHERE id=$1`, item.id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE data_sources SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, item.id); err != nil {
			return err
		}
	}
	return nil
}

// purgeFeedPersonalData removes personal field values, and their overrides,
// whose record has not changed for longer than the field's retention.
func (s *Service) purgeFeedPersonalData(ctx context.Context, now time.Time) (int, error) {
	purged := 0
	for _, hosted := range s.hosted {
		if hosted.manifest.APIVersion < 3 {
			continue
		}
		for _, feed := range hosted.manifest.Feeds {
			for _, field := range feed.Fields {
				if field.Personal == nil {
					continue
				}
				cutoff := now.Add(-time.Duration(field.Personal.RetentionDays) * 24 * time.Hour)
				var touched []uuid.UUID
				var pending []manifestchanges.Change
				err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
					rows, err := tx.Query(ctx, `UPDATE plugin_feed_records r SET upstream=r.upstream-$3::text
						FROM plugin_feed_datasets d WHERE d.id=r.dataset_id AND d.plugin_id=$1 AND d.feed_id=$2
						AND r.updated_at<$4 AND r.upstream ? $3::text RETURNING r.dataset_id`, hosted.manifest.ID, feed.ID, field.Key, cutoff)
					if err != nil {
						return err
					}
					ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
					if err != nil {
						return err
					}
					if _, err := tx.Exec(ctx, `DELETE FROM plugin_feed_overrides o USING plugin_feed_datasets d
						WHERE d.id=o.dataset_id AND d.plugin_id=$1 AND d.feed_id=$2 AND o.field_key=$3 AND o.updated_at<$4`,
						hosted.manifest.ID, feed.ID, field.Key, cutoff); err != nil {
						return err
					}
					seen := map[uuid.UUID]bool{}
					for _, id := range ids {
						if !seen[id] {
							seen[id] = true
							touched = append(touched, id)
						}
					}
					purged += len(ids)
					for _, id := range touched {
						changes, err := s.projectFeedDataset(ctx, tx, id, "plugin.feed.retention")
						if err != nil {
							return err
						}
						pending = append(pending, changes...)
					}
					return nil
				})
				if err != nil {
					return purged, err
				}
				s.notifyDataSources(pending)
			}
		}
	}
	return purged, nil
}

// feedAttention is the plugin status note for failed image imports.
func (s *Service) feedAttention(ctx context.Context, pluginID string) ([]PluginAttention, error) {
	var failures int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM plugin_feed_image_failures f JOIN plugin_feed_datasets d ON d.id=f.dataset_id WHERE d.plugin_id=$1`, pluginID).Scan(&failures); err != nil {
		return nil, err
	}
	if failures == 0 {
		return nil, nil
	}
	return []PluginAttention{{Code: "feed_image_import_failed", Message: "Some feed images could not be imported. Their records show no image; the feed page says why."}}, nil
}

// FeedReview is one declared feed as the install review shows it: what the
// plugin publishes for Widgets, and which fields hold personal data for how
// long.
type FeedReview struct {
	ID       string           `json:"id"`
	Title    string           `json:"title"`
	Provider string           `json:"provider"`
	Dataset  string           `json:"dataset"`
	Fields   int              `json:"fields"`
	Personal []PersonalReview `json:"personal"`
	Images   bool             `json:"images"`
}

// PersonalReview is one personal feed field and its retention.
type PersonalReview struct {
	Key           string `json:"key"`
	Label         string `json:"label"`
	RetentionDays int    `json:"retentionDays"`
}

func feedReviews(m plugin.Manifest) []FeedReview {
	out := []FeedReview{}
	for _, feed := range m.Feeds {
		review := FeedReview{ID: feed.ID, Title: feed.Title, Provider: feed.ProviderID(m.ID), Dataset: feed.Dataset,
			Fields: len(feed.Fields), Personal: []PersonalReview{}}
		for _, field := range feed.Fields {
			if field.Personal != nil {
				review.Personal = append(review.Personal, PersonalReview{Key: field.Key, Label: field.Label, RetentionDays: field.Personal.RetentionDays})
			}
			if field.Image != nil {
				review.Images = true
			}
		}
		out = append(out, review)
	}
	return out
}
