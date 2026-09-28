package media

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// defaultPrivateAssetMaxBytes bounds a private plugin asset when no media upload limit is configured.
const defaultPrivateAssetMaxBytes = 25 << 20

// IngestPrivateAsset creates a dedicated private plugin asset from uploaded
// bytes and stamps it with the owning plugin's identity. Unlike the generic
// upload path it stamps the historical private origin at creation (retained
// from the Forms attachment era; see migration 00106), so the asset can
// never be selected as public Media and never enters a manifest until an
// owning projection references it. The bytes must be an image; other types
// are rejected. Callers reach this through Host.PluginAssets, which binds
// the plugin identity; the owning plugin authorizes the upload against its
// own records first.
func (s *Service) IngestPrivateAsset(ctx context.Context, pluginID string, userID uuid.UUID, filename, declaredMIME string, data []byte) (Asset, error) {
	if s.storage == nil {
		return Asset{}, errors.New("media storage is not configured")
	}
	if strings.TrimSpace(pluginID) == "" {
		return Asset{}, errors.New("private plugin assets need an owning plugin")
	}
	if len(data) == 0 {
		return Asset{}, errors.New("attachment is empty")
	}
	maxBytes := s.cfg.MaxUploadBytes
	if maxBytes <= 0 {
		maxBytes = defaultPrivateAssetMaxBytes
	}
	if int64(len(data)) > maxBytes {
		return Asset{}, ErrUploadTooLarge
	}
	header := data
	if len(header) > 512 {
		header = data[:512]
	}
	detected, err := DetectType(header)
	if err != nil {
		return Asset{}, err
	}
	if detected.AssetType != "image" {
		return Asset{}, errors.New("private plugin assets must be images")
	}
	var organizationID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&organizationID); err != nil {
		return Asset{}, err
	}
	assetID, variantID := uuid.New(), uuid.New()
	finalKey := OriginalKey(assetID, detected.Extension)
	if err := s.storage.WriteAtomic(finalKey, func(w io.Writer) error { _, writeErr := w.Write(data); return writeErr }); err != nil {
		return Asset{}, err
	}
	sum := sha256.Sum256(data)
	name := strings.TrimSuffix(filename, filepath.Ext(filename))
	if strings.TrimSpace(name) == "" {
		name = "Attachment"
	}
	if len(name) > 180 {
		name = name[:180]
	}
	now := time.Now().UTC()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		_ = s.storage.Delete(finalKey)
		return Asset{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	cleanup := func(cause error) (Asset, error) {
		_ = s.storage.Delete(finalKey)
		return Asset{}, cause
	}
	if _, err := tx.Exec(ctx, `INSERT INTO assets (id,organization_id,name,type,original_filename,declared_mime_type,detected_mime_type,sha256,original_size,processing_status,origin,owning_plugin,created_by,created_at,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued','form_attachment',$10,$11,$12,$12)`,
		assetID, organizationID, name, detected.AssetType, filename, declaredMIME, detected.MIMEType, sum[:], int64(len(data)), pluginID, userID, now); err != nil {
		return cleanup(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO asset_variants (id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256)
		VALUES ($1,$2,'original','local',$3,$4,$5,$6)`, variantID, assetID, finalKey, detected.MIMEType, int64(len(data)), sum[:]); err != nil {
		return cleanup(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO media_jobs (id,asset_id,kind,status) VALUES ($1,$2,'inspect_asset','queued')`, uuid.New(), assetID); err != nil {
		return cleanup(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs (id,user_id,action,resource_type,resource_id,metadata)
		VALUES ($1,$2,'form.attachment_uploaded','asset',$3,jsonb_build_object('filename',$4::text))`, uuid.New(), userID, assetID.String(), filename); err != nil {
		return cleanup(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return cleanup(err)
	}
	// Internal read: this is the one place that legitimately returns a private plugin asset.
	return s.getAsset(ctx, assetID, true)
}

// PrivateAssetDelivery returns a servable file for one owning plugin's
// private asset, choosing the best available variant (a generated
// thumbnail/poster/playback rendition when present, otherwise the original
// upload). Unlike Preview/PlaybackPreview it does not require the asset to
// have finished asynchronous processing, so an image is servable immediately
// after IngestPrivateAsset. It only ever serves the calling plugin's own
// private assets; the owning plugin authorizes the requesting user against
// its own records before calling this.
func (s *Service) PrivateAssetDelivery(ctx context.Context, pluginID string, assetID uuid.UUID) (Delivery, error) {
	if s.storage == nil {
		return Delivery{}, errors.New("media storage is not configured")
	}
	d := Delivery{AssetID: assetID}
	var key string
	err := s.db.QueryRow(ctx, `SELECT v.id,v.storage_key,v.mime_type,v.file_size,encode(v.sha256,'hex')
		FROM asset_variants v JOIN assets a ON a.id=v.asset_id
		WHERE a.id=$1 AND a.deleted_at IS NULL AND a.origin='form_attachment' AND a.owning_plugin=$2 AND v.deleted_at IS NULL
		ORDER BY CASE v.kind WHEN 'thumbnail' THEN 0 WHEN 'poster' THEN 1 WHEN 'playback' THEN 2 WHEN 'original' THEN 3 ELSE 4 END
		LIMIT 1`, assetID, pluginID).Scan(&d.VariantID, &key, &d.MIMEType, &d.Size, &d.HashHex)
	if errors.Is(err, pgx.ErrNoRows) {
		return Delivery{}, ErrVariantUnavailable
	}
	if err != nil {
		return Delivery{}, err
	}
	d.Path, err = s.storage.Path(key)
	return d, err
}

// SoftDeletePrivateAsset soft-deletes one owning plugin's private asset and
// queues its storage cleanup. It refuses to touch anything other than a
// private asset owned by the calling plugin, so it can never remove a Media
// library item or another plugin's upload. Removing a nonexistent or
// already-deleted attachment is a no-op.
func (s *Service) SoftDeletePrivateAsset(ctx context.Context, pluginID string, assetID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var origin string
	var owner *string
	err = tx.QueryRow(ctx, `SELECT origin,owning_plugin FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, assetID).Scan(&origin, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if origin != "form_attachment" || owner == nil || *owner != pluginID {
		return errors.New("asset is not a private asset of this plugin")
	}
	if _, err := tx.Exec(ctx, `UPDATE assets SET processing_status='deleting',deleted_at=now(),updated_at=now() WHERE id=$1`, assetID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO media_jobs(id,asset_id,kind,status) VALUES($1,$2,'delete_asset_files','queued') ON CONFLICT DO NOTHING`, uuid.New(), assetID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Private plugin-managed attachments live here because core owns bytes,
// storage, processing, and delivery. The owning plugin authorizes every call
// against its own records through Host.PluginAssets and owns replacement
// semantics; this file never learns workflow permissions.
//
// The Form Data Source provider itself (stored configuration shape,
// normalization, field discovery) is contributed by the Forms plugin. The
// "form_records" adapter resolves through that contribution, so generic
// paths never name the provider.
