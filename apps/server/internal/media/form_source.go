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

// defaultFormAttachmentMaxBytes bounds a form attachment when no media upload limit is configured.
const defaultFormAttachmentMaxBytes = 25 << 20

// IngestFormAttachment creates a dedicated form-attachment asset from uploaded bytes. Unlike the
// generic upload path it stamps origin='form_attachment' at creation, so the asset can never be
// selected as public Media and never enters a manifest until an approving projection references it.
// The bytes must be an image; other types are rejected. Submitters can call this without general
// Media-management permission (the forms layer authorizes them against the target record).
func (s *Service) IngestFormAttachment(ctx context.Context, userID uuid.UUID, filename, declaredMIME string, data []byte) (Asset, error) {
	if s.storage == nil {
		return Asset{}, errors.New("media storage is not configured")
	}
	if len(data) == 0 {
		return Asset{}, errors.New("attachment is empty")
	}
	maxBytes := s.cfg.MaxUploadBytes
	if maxBytes <= 0 {
		maxBytes = defaultFormAttachmentMaxBytes
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
		return Asset{}, errors.New("form attachments must be images")
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
	if _, err := tx.Exec(ctx, `INSERT INTO assets (id,organization_id,name,type,original_filename,declared_mime_type,detected_mime_type,sha256,original_size,processing_status,origin,created_by,created_at,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued','form_attachment',$10,$11,$11)`,
		assetID, organizationID, name, detected.AssetType, filename, declaredMIME, detected.MIMEType, sum[:], int64(len(data)), userID, now); err != nil {
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
	// Internal read: this is the one place that legitimately returns a form-attachment asset.
	return s.getAsset(ctx, assetID, true)
}

// FormAttachmentDelivery returns a servable file for a form-attachment asset, choosing the best
// available variant (a generated thumbnail/poster/playback rendition when present, otherwise the
// original upload). Unlike Preview/PlaybackPreview it does not require the asset to have finished
// asynchronous processing, so an image is servable immediately after IngestFormAttachment. It only
// ever serves assets with origin='form_attachment'; callers (the forms package) authorize the
// requesting user against the owning record before calling this.
func (s *Service) FormAttachmentDelivery(ctx context.Context, assetID uuid.UUID) (Delivery, error) {
	if s.storage == nil {
		return Delivery{}, errors.New("media storage is not configured")
	}
	d := Delivery{AssetID: assetID}
	var key string
	err := s.db.QueryRow(ctx, `SELECT v.id,v.storage_key,v.mime_type,v.file_size,encode(v.sha256,'hex')
		FROM asset_variants v JOIN assets a ON a.id=v.asset_id
		WHERE a.id=$1 AND a.deleted_at IS NULL AND a.origin='form_attachment' AND v.deleted_at IS NULL
		ORDER BY CASE v.kind WHEN 'thumbnail' THEN 0 WHEN 'poster' THEN 1 WHEN 'playback' THEN 2 WHEN 'original' THEN 3 ELSE 4 END
		LIMIT 1`, assetID).Scan(&d.VariantID, &key, &d.MIMEType, &d.Size, &d.HashHex)
	if errors.Is(err, pgx.ErrNoRows) {
		return Delivery{}, ErrVariantUnavailable
	}
	if err != nil {
		return Delivery{}, err
	}
	d.Path, err = s.storage.Path(key)
	return d, err
}

// SoftDeleteFormAttachment soft-deletes a form-attachment asset and queues its storage cleanup. It
// refuses to touch anything other than an origin='form_attachment' asset, so it can never remove a
// Media library item. Removing a nonexistent or already-deleted attachment is a no-op.
func (s *Service) SoftDeleteFormAttachment(ctx context.Context, assetID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var origin string
	err = tx.QueryRow(ctx, `SELECT origin FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, assetID).Scan(&origin)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if origin != "form_attachment" {
		return errors.New("asset is not a form attachment")
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
