package playlists

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/editorial"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
)

// playlistSnapshot is intentionally a whole definition. It is used for
// submissions and publication, never reconstructed from whatever the working
// rows happen to contain later.
type playlistSnapshot struct {
	Name               string                 `json:"name"`
	Description        string                 `json:"description"`
	SourceType         string                 `json:"sourceType"`
	TagMatch           string                 `json:"tagMatch"`
	TagImageDurationMS int64                  `json:"tagImageDurationMs"`
	Items              []playlistSnapshotItem `json:"items"`
	TagIDs             []uuid.UUID            `json:"tagIds"`
}

type playlistSnapshotItem struct {
	ID                 uuid.UUID  `json:"id"`
	AssetID            *uuid.UUID `json:"assetId,omitempty"`
	LayoutID           *uuid.UUID `json:"layoutId,omitempty"`
	Position           int        `json:"position"`
	DurationMS         *int64     `json:"durationMs,omitempty"`
	FitMode            string     `json:"fitMode"`
	Transition         string     `json:"transition"`
	AudioEnabled       bool       `json:"audioEnabled"`
	Volume             float64    `json:"volume"`
	VideoStartOffsetMS *int64     `json:"videoStartOffsetMs,omitempty"`
	VideoEndOffsetMS   *int64     `json:"videoEndOffsetMs,omitempty"`
	DeliveryPolicy     string     `json:"deliveryPolicy"`
	UsePlayerDefaults  bool       `json:"usePlayerDefaults"`
}

func canonicalPlaylistSnapshot(document playlistSnapshot) ([]byte, string, error) {
	if document.Items == nil {
		document.Items = []playlistSnapshotItem{}
	}
	if document.TagIDs == nil {
		document.TagIDs = []uuid.UUID{}
	}
	raw, err := json.Marshal(document)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(raw)
	return raw, hex.EncodeToString(digest[:]), nil
}

func ensureDraftTx(ctx context.Context, tx pgx.Tx, playlistID uuid.UUID) error {
	var inserted uuid.UUID
	err := tx.QueryRow(ctx, `
		INSERT INTO playlist_drafts(playlist_id,revision,published_draft_revision,name,description,source_type,tag_match,tag_image_duration_ms,updated_by,updated_at)
		SELECT id,revision,revision,name,description,source_type,tag_match,tag_image_duration_ms,created_by,updated_at
		FROM playlists WHERE id=$1 AND deleted_at IS NULL
		ON CONFLICT (playlist_id) DO NOTHING
		RETURNING playlist_id`, playlistID).Scan(&inserted)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO playlist_draft_items(id,playlist_id,asset_id,layout_id,position,duration_ms,fit_mode,transition,audio_enabled,volume,video_start_offset_ms,video_end_offset_ms,delivery_policy,use_player_defaults,created_at,updated_at)
		SELECT i.id,i.playlist_id,i.asset_id,i.layout_id,i.position,i.duration_ms,i.fit_mode,i.transition,i.audio_enabled,i.volume,i.video_start_offset_ms,i.video_end_offset_ms,i.delivery_policy,i.use_player_defaults,i.created_at,i.updated_at
		FROM playlist_items i WHERE i.playlist_id=$1 ON CONFLICT (id) DO NOTHING`, playlistID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO playlist_draft_tags(playlist_id,tag_id)
		SELECT playlist_id,tag_id FROM playlist_tags WHERE playlist_id=$1 ON CONFLICT DO NOTHING`, playlistID)
	return err
}

func bumpDraftTx(ctx context.Context, tx pgx.Tx, playlistID, userID uuid.UUID) (int64, error) {
	if err := ensureDraftTx(ctx, tx, playlistID); err != nil {
		return 0, err
	}
	var revision int64
	err := tx.QueryRow(ctx, `UPDATE playlist_drafts SET revision=revision+1,updated_by=$2,updated_at=now() WHERE playlist_id=$1 RETURNING revision`, playlistID, userID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return revision, err
}

func snapshotDraftTx(ctx context.Context, tx pgx.Tx, playlistID uuid.UUID) (editorial.Snapshot, error) {
	if err := ensureDraftTx(ctx, tx, playlistID); err != nil {
		return editorial.Snapshot{}, err
	}
	var document playlistSnapshot
	var snapshot editorial.Snapshot
	var tagIDs []uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT d.revision,d.name,d.description,d.source_type,d.tag_match,d.tag_image_duration_ms,p.revision,r.id FROM playlist_drafts d JOIN playlists p ON p.id=d.playlist_id LEFT JOIN playlist_revisions r ON r.playlist_id=p.id AND r.revision=p.revision WHERE d.playlist_id=$1 AND p.deleted_at IS NULL`, playlistID).
		Scan(&snapshot.WorkingRevision, &document.Name, &document.Description, &document.SourceType, &document.TagMatch, &document.TagImageDurationMS, &snapshot.PublishedRevision, &snapshot.PublishedRevisionID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return editorial.Snapshot{}, ErrNotFound
		}
		return editorial.Snapshot{}, err
	}
	rows, err := tx.Query(ctx, `SELECT id,asset_id,layout_id,position,duration_ms,fit_mode,transition,audio_enabled,volume,video_start_offset_ms,video_end_offset_ms,delivery_policy,use_player_defaults FROM playlist_draft_items WHERE playlist_id=$1 ORDER BY position,id`, playlistID)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	for rows.Next() {
		var item playlistSnapshotItem
		if err = rows.Scan(&item.ID, &item.AssetID, &item.LayoutID, &item.Position, &item.DurationMS, &item.FitMode, &item.Transition, &item.AudioEnabled, &item.Volume, &item.VideoStartOffsetMS, &item.VideoEndOffsetMS, &item.DeliveryPolicy, &item.UsePlayerDefaults); err != nil {
			rows.Close()
			return editorial.Snapshot{}, err
		}
		document.Items = append(document.Items, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return editorial.Snapshot{}, err
	}
	rows.Close()
	tagRows, err := tx.Query(ctx, `SELECT tag_id FROM playlist_draft_tags WHERE playlist_id=$1 ORDER BY tag_id`, playlistID)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	for tagRows.Next() {
		var tagID uuid.UUID
		if err = tagRows.Scan(&tagID); err != nil {
			tagRows.Close()
			return editorial.Snapshot{}, err
		}
		tagIDs = append(tagIDs, tagID)
	}
	if err = tagRows.Err(); err != nil {
		tagRows.Close()
		return editorial.Snapshot{}, err
	}
	tagRows.Close()
	document.TagIDs = tagIDs
	raw, digest, err := canonicalPlaylistSnapshot(document)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	snapshot.Document, snapshot.Digest = raw, digest
	return snapshot, nil
}

// GetDraft is the authoring view. Runtime callers must use GetPublished so a
// working edit cannot leak into a manifest.
func (s *Service) GetDraft(ctx context.Context, id uuid.UUID) (Playlist, error) {
	p, err := s.Get(ctx, id)
	if err != nil {
		return Playlist{}, err
	}
	var rawName, description, sourceType, tagMatch string
	var draftRevision, tagDuration int64
	var publishedDraftRevision int64
	if err = s.db.QueryRow(ctx, `SELECT d.name,d.description,d.source_type,d.tag_match,d.tag_image_duration_ms,d.revision,d.published_draft_revision,p.revision FROM playlist_drafts d JOIN playlists p ON p.id=d.playlist_id WHERE d.playlist_id=$1 AND p.deleted_at IS NULL`, id).
		Scan(&rawName, &description, &sourceType, &tagMatch, &tagDuration, &draftRevision, &publishedDraftRevision, &p.PublishedRevision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return p, nil
		}
		return Playlist{}, err
	}
	p.Name, p.Description, p.SourceType = rawName, description, sourceType
	p.Revision = p.PublishedRevision
	p.DraftRevision = draftRevision
	// A revision is synchronized after publishing an unchanged draft.  A
	// differing revision is therefore a conservative, useful UI signal.
	p.HasUnpublishedChanges = draftRevision != publishedDraftRevision
	p.Items = []Item{}
	p.Warnings = []string{}
	p.TagRule = nil
	if sourceType == "tag" {
		p.TagRule = &TagRule{Match: tagMatch, ImageDurationMS: tagDuration, Tags: []PlaylistTag{}}
		rows, queryErr := s.db.Query(ctx, `SELECT t.id,t.name,t.color FROM playlist_draft_tags pt JOIN content_tags t ON t.id=pt.tag_id WHERE pt.playlist_id=$1 ORDER BY lower(t.name),t.id`, id)
		if queryErr != nil {
			return Playlist{}, queryErr
		}
		for rows.Next() {
			var tag PlaylistTag
			if queryErr = rows.Scan(&tag.ID, &tag.Name, &tag.Color); queryErr != nil {
				rows.Close()
				return Playlist{}, queryErr
			}
			p.TagRule.Tags = append(p.TagRule.Tags, tag)
		}
		if queryErr = rows.Err(); queryErr != nil {
			rows.Close()
			return Playlist{}, queryErr
		}
		rows.Close()
	}
	itemQuery := `SELECT i.id,COALESCE(i.asset_id,'00000000-0000-0000-0000-000000000000'::uuid),i.layout_id,i.position,i.duration_ms,i.fit_mode,i.transition,i.audio_enabled,i.volume,i.video_start_offset_ms,i.video_end_offset_ms,i.delivery_policy,i.use_player_defaults,COALESCE(a.name,l.name),CASE WHEN i.layout_id IS NOT NULL THEN 'layout' ELSE a.type END,COALESCE(w.provider,''),CASE WHEN i.layout_id IS NOT NULL THEN CASE WHEN l.published_revision_id IS NOT NULL THEN 'ready' ELSE 'draft' END ELSE a.processing_status END,a.duration_seconds,v.id,i.created_at,i.updated_at,a.available_from,a.expires_at,FALSE FROM playlist_draft_items i LEFT JOIN assets a ON a.id=i.asset_id LEFT JOIN layouts l ON l.id=i.layout_id AND l.deleted_at IS NULL LEFT JOIN widgets w ON w.asset_id=a.id LEFT JOIN LATERAL(SELECT id FROM asset_variants WHERE asset_id=a.id AND deleted_at IS NULL AND player_compatible=TRUE ORDER BY CASE kind WHEN 'playback' THEN 0 WHEN 'original' THEN 1 ELSE 2 END,id LIMIT 1)v ON TRUE WHERE i.playlist_id=$1 ORDER BY i.position`
	if sourceType == "tag" {
		itemQuery = `WITH matched AS (SELECT at.asset_id FROM content_asset_tags at JOIN playlist_draft_tags pt ON pt.tag_id=at.tag_id WHERE pt.playlist_id=$1 GROUP BY at.asset_id HAVING ($2='any' AND count(*)>0) OR ($2='all' AND count(*)=(SELECT count(*) FROM playlist_draft_tags WHERE playlist_id=$1))) SELECT a.id,a.id,NULL::uuid,row_number() OVER(ORDER BY lower(a.name),a.id)-1,CASE WHEN a.type='image' THEN $3::bigint ELSE NULL::bigint END,'contain','none',TRUE,1,NULL::bigint,NULL::bigint,'download',FALSE,a.name,a.type,'',a.processing_status,a.duration_seconds,v.id,a.created_at,a.updated_at,a.available_from,a.expires_at,TRUE FROM matched m JOIN assets a ON a.id=m.asset_id LEFT JOIN LATERAL(SELECT id FROM asset_variants WHERE asset_id=a.id AND deleted_at IS NULL AND player_compatible=TRUE ORDER BY CASE kind WHEN 'playback' THEN 0 WHEN 'original' THEN 1 ELSE 2 END,id LIMIT 1)v ON TRUE WHERE a.deleted_at IS NULL AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) AND a.origin='library' AND a.type IN ('image','video') AND a.processing_status='ready' AND v.id IS NOT NULL ORDER BY lower(a.name),a.id`
	}
	var rows pgx.Rows
	if sourceType == "tag" {
		rows, err = s.db.Query(ctx, itemQuery, id, tagMatch, tagDuration)
	} else {
		rows, err = s.db.Query(ctx, itemQuery, id)
	}
	if err != nil {
		return Playlist{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var item Item
		if err = rows.Scan(&item.ID, &item.AssetID, &item.LayoutID, &item.Position, &item.DurationMS, &item.FitMode, &item.Transition, &item.AudioEnabled, &item.Volume, &item.VideoStartOffsetMS, &item.VideoEndOffsetMS, &item.DeliveryPolicy, &item.UsePlayerDefaults, &item.AssetName, &item.AssetType, &item.WidgetProvider, &item.AssetStatus, &item.AssetDurationSeconds, &item.VariantID, &item.CreatedAt, &item.UpdatedAt, &item.AvailableFrom, &item.ExpiresAt, &item.Dynamic); err != nil {
			return Playlist{}, err
		}
		if item.AssetID != uuid.Nil {
			item.ThumbnailURL = "/api/v1/assets/" + item.AssetID.String() + "/thumbnail"
		}
		if item.AssetStatus != "ready" || (item.AssetType != "widget" && item.AssetType != "layout" && item.VariantID == nil) {
			p.Warnings = append(p.Warnings, "Asset "+item.AssetName+" is no longer ready for playback.")
		}
		p.Items = append(p.Items, item)
	}
	p.ItemCount = len(p.Items)
	return p, rows.Err()
}

func (s *Service) SnapshotTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (editorial.Snapshot, error) {
	return snapshotDraftTx(ctx, tx, id)
}

// lockAssetReferences serializes new playlist references with asset deletion.
// Deletion takes the same lock before it checks for references, so either the
// deletion sees the new item, or this validation sees the asset as deleted.
func lockAssetReferences(ctx context.Context, tx pgx.Tx, assets []uuid.UUID) error {
	sort.Slice(assets, func(i, j int) bool { return assets[i].String() < assets[j].String() })
	for _, id := range assets {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('tilecast.media.asset.'||$1))`, id.String()); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) ValidateSnapshotTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, raw json.RawMessage) error {
	var document playlistSnapshot
	if err := json.Unmarshal(raw, &document); err != nil {
		return fmt.Errorf("playlist snapshot is invalid: %w", err)
	}
	if err := validateDetails(document.Name, document.Description); err != nil {
		return err
	}
	if document.SourceType != "static" && document.SourceType != "tag" {
		return errors.New("playlist sourceType must be static or tag")
	}
	if document.TagMatch != "any" && document.TagMatch != "all" {
		return errors.New("tag match must be any or all")
	}
	if document.TagImageDurationMS < 1000 || document.TagImageDurationMS > 86400000 {
		return errors.New("tag playlist image duration is invalid")
	}
	if document.SourceType == "tag" && len(document.TagIDs) == 0 {
		return errors.New("tag playlist must select at least one tag")
	}
	for _, tagID := range document.TagIDs {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM content_tags WHERE id=$1)`, tagID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("tag %s is missing", tagID)
		}
	}
	seen := map[uuid.UUID]bool{}
	var assets []uuid.UUID
	for _, item := range document.Items {
		if item.AssetID != nil {
			assets = append(assets, *item.AssetID)
		}
	}
	if err := lockAssetReferences(ctx, tx, assets); err != nil {
		return err
	}
	for _, item := range document.Items {
		if item.ID == uuid.Nil || seen[item.ID] {
			return errors.New("playlist snapshot contains duplicate item ids")
		}
		seen[item.ID] = true
		input := ItemInput{AssetID: uuid.Nil, LayoutID: item.LayoutID, DurationMS: item.DurationMS, FitMode: item.FitMode, Transition: item.Transition, AudioEnabled: &item.AudioEnabled, Volume: &item.Volume, VideoStartOffsetMS: item.VideoStartOffsetMS, VideoEndOffsetMS: item.VideoEndOffsetMS, DeliveryPolicy: item.DeliveryPolicy, UsePlayerDefaults: item.UsePlayerDefaults}
		if item.AssetID != nil {
			input.AssetID = *item.AssetID
		}
		if _, _, err := s.validateItem(ctx, tx, input); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) PublishSnapshotTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, raw json.RawMessage, workingRevision int64, userID uuid.UUID) (editorial.Published, error) {
	var document playlistSnapshot
	if err := json.Unmarshal(raw, &document); err != nil {
		return editorial.Published{}, err
	}
	if err := s.ValidateSnapshotTx(ctx, tx, id, raw); err != nil {
		return editorial.Published{}, err
	}
	var current int64
	if err := tx.QueryRow(ctx, `SELECT revision FROM playlists WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&current); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return editorial.Published{}, ErrNotFound
		}
		return editorial.Published{}, err
	}
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT GREATEST($2::bigint,COALESCE(max(revision),0))+1 FROM playlist_revisions WHERE playlist_id=$1`, id, current).Scan(&revision); err != nil {
		return editorial.Published{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM playlist_items WHERE playlist_id=$1`, id); err != nil {
		return editorial.Published{}, err
	}
	for position, item := range document.Items {
		itemID := item.ID
		if itemID == uuid.Nil {
			itemID = uuid.New()
		}
		if _, err := tx.Exec(ctx, `INSERT INTO playlist_items(id,playlist_id,asset_id,layout_id,position,duration_ms,fit_mode,transition,audio_enabled,volume,video_start_offset_ms,video_end_offset_ms,delivery_policy,use_player_defaults) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, itemID, id, item.AssetID, item.LayoutID, position, item.DurationMS, item.FitMode, item.Transition, item.AudioEnabled, item.Volume, item.VideoStartOffsetMS, item.VideoEndOffsetMS, item.DeliveryPolicy, item.UsePlayerDefaults); err != nil {
			return editorial.Published{}, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM playlist_tags WHERE playlist_id=$1`, id); err != nil {
		return editorial.Published{}, err
	}
	for _, tagID := range document.TagIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO playlist_tags(playlist_id,tag_id) VALUES($1,$2)`, id, tagID); err != nil {
			return editorial.Published{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE playlists SET name=$2,description=$3,source_type=$4,tag_match=$5,tag_image_duration_ms=$6,revision=$7,updated_at=now() WHERE id=$1`, id, document.Name, document.Description, document.SourceType, document.TagMatch, document.TagImageDurationMS, revision); err != nil {
		return editorial.Published{}, err
	}
	if err := snapshotRevision(ctx, tx, id, &userID); err != nil {
		return editorial.Published{}, err
	}
	var revisionID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM playlist_revisions WHERE playlist_id=$1 AND revision=$2`, id, revision).Scan(&revisionID); err != nil {
		return editorial.Published{}, err
	}
	// Publishing an unchanged working copy closes the draft.  If the author
	// continued editing after submission, the newer working copy must remain
	// intact; the immutable submission is allowed to publish independently.
	if err := ensureDraftTx(ctx, tx, id); err != nil {
		return editorial.Published{}, err
	}
	if workingRevision > 0 {
		if _, err := tx.Exec(ctx, `UPDATE playlist_drafts SET published_draft_revision=$2,updated_at=now() WHERE playlist_id=$1 AND revision=$2`, id, workingRevision); err != nil {
			return editorial.Published{}, err
		}
	}
	notifications, err := bumpAssigned(ctx, tx, id, "playlist.published")
	if err != nil {
		return editorial.Published{}, err
	}
	return editorial.Published{Revision: revision, RevisionID: &revisionID, Changes: manifestChanges(notifications), AffectedScreens: len(notifications)}, nil
}

func (s *Service) RestoreDraftTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, raw json.RawMessage, userID uuid.UUID) error {
	var document playlistSnapshot
	if err := json.Unmarshal(raw, &document); err != nil {
		return err
	}
	if err := s.ValidateSnapshotTx(ctx, tx, id, raw); err != nil {
		return err
	}
	if err := ensureDraftTx(ctx, tx, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM playlist_draft_items WHERE playlist_id=$1`, id); err != nil {
		return err
	}
	for position, item := range document.Items {
		if _, err := tx.Exec(ctx, `INSERT INTO playlist_draft_items(id,playlist_id,asset_id,layout_id,position,duration_ms,fit_mode,transition,audio_enabled,volume,video_start_offset_ms,video_end_offset_ms,delivery_policy,use_player_defaults) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, item.ID, id, item.AssetID, item.LayoutID, position, item.DurationMS, item.FitMode, item.Transition, item.AudioEnabled, item.Volume, item.VideoStartOffsetMS, item.VideoEndOffsetMS, item.DeliveryPolicy, item.UsePlayerDefaults); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM playlist_draft_tags WHERE playlist_id=$1`, id); err != nil {
		return err
	}
	for _, tagID := range document.TagIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO playlist_draft_tags(playlist_id,tag_id) VALUES($1,$2)`, id, tagID); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `UPDATE playlist_drafts SET name=$2,description=$3,source_type=$4,tag_match=$5,tag_image_duration_ms=$6,revision=revision+1,updated_by=$7,updated_at=now() WHERE playlist_id=$1`, id, document.Name, document.Description, document.SourceType, document.TagMatch, document.TagImageDurationMS, userID)
	return err
}

func (s *Service) NotifyPublication(changes []manifestchanges.Change) {
	s.NotifyManifestChanges(changes)
}

func (s *Service) DraftSnapshot(ctx context.Context, id uuid.UUID) (editorial.Snapshot, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	defer tx.Rollback(ctx)
	snapshot, err := snapshotDraftTx(ctx, tx, id)
	if err != nil {
		return editorial.Snapshot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return editorial.Snapshot{}, err
	}
	return snapshot, nil
}

// Keep the compiler honest when this file is built against older pgx versions
// in downstream integrations.
var _ = time.Time{}
