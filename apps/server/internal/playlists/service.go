package playlists

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/apps/server/internal/span"
)

type Service struct {
	db                    *pgxpool.Pool
	notifier              Notifier
	scheduling            *scheduling.Service
	sources               SourceProjector
	definitions           *contentdefs.Catalog
	plugins               PluginProjector
	presentationOverrides PresentationOverrideProjector
	span                  SpanProjector
	// approvalGate refuses assignment of content that is waiting for review.
	// Nil means this installation does not gate assignment at all. It runs inside
	// the assignment transaction so the answer cannot go stale before the commit.
	approvalGate func(ctx context.Context, tx pgx.Tx, contentType string, id uuid.UUID) error
}

type SourceProjector interface {
	PlayerDataSourceConfiguration(context.Context, uuid.UUID, string, json.RawMessage) (json.RawMessage, error)
	PlayerTypedDataSourceConfiguration(context.Context, uuid.UUID, string, json.RawMessage) (json.RawMessage, error)
}

type PluginProjector interface {
	ManifestForScreen(context.Context, uuid.UUID) ([]plugins.ManifestPlugin, error)
}

type SpanProjector interface {
	ViewportForScreen(context.Context, uuid.UUID) (*span.Panel, *span.Canvas, error)
	PrepareVideo(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (span.VideoPanel, error)
}

func NewService(db *pgxpool.Pool, notifier Notifier) *Service {
	return &Service{db: db, notifier: notifier, definitions: contentdefs.MustLoad()}
}

func (s *Service) SetScheduling(service *scheduling.Service)          { s.scheduling = service }
func (s *Service) SetSourceProjector(projector SourceProjector)       { s.sources = projector }
func (s *Service) SetContentDefinitions(catalog *contentdefs.Catalog) { s.definitions = catalog }
func (s *Service) SetPluginProjector(projector PluginProjector)       { s.plugins = projector }
func (s *Service) SetSpanProjector(projector SpanProjector)           { s.span = projector }
func (s *Service) SetPresentationOverrides(projector PresentationOverrideProjector) {
	s.presentationOverrides = projector
}

// SetApprovalGate installs the content review check used by every assignment
// path. The gate takes the assignment's own transaction: it locks the content
// against a concurrent edit, and that lock is only worth anything if it is held
// until the assignment commits.
func (s *Service) SetApprovalGate(gate func(ctx context.Context, tx pgx.Tx, contentType string, id uuid.UUID) error) {
	s.approvalGate = gate
}

// passApprovalGate runs the review check for whichever presentation an
// assignment names. Exactly one of playlistID and layoutID is set by the time
// it is called. It is a no-op unless the approval feature is wired in.
func (s *Service) passApprovalGate(ctx context.Context, tx pgx.Tx, playlistID, layoutID *uuid.UUID) error {
	if s.approvalGate == nil {
		return nil
	}
	contentType, contentID := "layout", layoutID
	if playlistID != nil {
		contentType, contentID = "playlist", playlistID
	}
	return s.approvalGate(ctx, tx, contentType, *contentID)
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, name, description, sourceType string) (Playlist, error) {
	name = strings.TrimSpace(name)
	description = strings.TrimSpace(description)
	if err := validateDetails(name, description); err != nil {
		return Playlist{}, err
	}
	sourceType, err := normalizeSourceType(sourceType)
	if err != nil {
		return Playlist{}, err
	}
	var org uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&org); err != nil {
		return Playlist{}, err
	}
	id := uuid.New()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,description,source_type,created_by)VALUES($1,$2,$3,$4,$5,$6)`, id, org, name, description, sourceType, userID)
	if err != nil {
		return Playlist{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO playlist_drafts(playlist_id,revision,published_draft_revision,name,description,source_type,tag_match,tag_image_duration_ms,updated_by)VALUES($1,1,1,$2,$3,$4,'any',10000,$5)`, id, name, description, sourceType, userID); err != nil {
		return Playlist{}, err
	}
	if err = insertAudit(ctx, tx, userID, "playlist.created", id); err != nil {
		return Playlist{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Playlist{}, err
	}
	return s.Get(ctx, id)
}

func normalizeSourceType(sourceType string) (string, error) {
	sourceType = strings.TrimSpace(sourceType)
	if sourceType == "" {
		return "static", nil
	}
	if sourceType != "static" && sourceType != "tag" {
		return "", errors.New("playlist sourceType must be static or tag")
	}
	return sourceType, nil
}

func validateDetails(name, description string) error {
	if len(name) < 1 || len(name) > 180 {
		return errors.New("playlist name must be between 1 and 180 characters")
	}
	if len(description) > 2000 {
		return errors.New("playlist description must be at most 2000 characters")
	}
	return nil
}

func (s *Service) List(ctx context.Context, search string, page, pageSize int) (ListResult, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 30
	}
	if pageSize > 100 {
		pageSize = 100
	}
	search = strings.TrimSpace(search)
	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM playlists p LEFT JOIN playlist_drafts d ON d.playlist_id=p.id WHERE p.deleted_at IS NULL AND p.system_managed=FALSE AND ($1='' OR COALESCE(d.name,p.name) ILIKE '%'||$1||'%')`, search).Scan(&total); err != nil {
		return ListResult{}, err
	}
	rows, err := s.db.Query(ctx, `SELECT p.id,COALESCE(d.name,p.name),COALESCE(d.description,p.description),p.revision,COALESCE(d.revision,p.revision),COALESCE(d.revision,p.revision)<>COALESCE(d.published_draft_revision,p.revision),p.created_at,COALESCE(d.updated_at,p.updated_at),COALESCE(d.source_type,p.source_type),
		CASE WHEN COALESCE(d.source_type,p.source_type)='static' THEN
			CASE WHEN d.playlist_id IS NULL
				THEN (SELECT count(*) FROM playlist_items pi WHERE pi.playlist_id=p.id)
				ELSE (SELECT count(*) FROM playlist_draft_items di WHERE di.playlist_id=p.id)
			END
		ELSE CASE WHEN d.playlist_id IS NULL THEN (
			SELECT count(*) FROM assets a
			WHERE a.deleted_at IS NULL AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) AND a.origin='library' AND a.type IN('image','video') AND a.processing_status='ready'
			  AND EXISTS(SELECT 1 FROM asset_variants v WHERE v.asset_id=a.id AND v.deleted_at IS NULL AND v.player_compatible=TRUE)
			  AND EXISTS(SELECT 1 FROM playlist_tags selected WHERE selected.playlist_id=p.id)
			  AND ((p.tag_match='any' AND EXISTS(
			       SELECT 1 FROM content_asset_tags at JOIN playlist_tags selected ON selected.tag_id=at.tag_id
			       WHERE at.asset_id=a.id AND selected.playlist_id=p.id
			  )) OR (p.tag_match='all' AND NOT EXISTS(
			       SELECT 1 FROM playlist_tags selected WHERE selected.playlist_id=p.id
			       AND NOT EXISTS(SELECT 1 FROM content_asset_tags at WHERE at.asset_id=a.id AND at.tag_id=selected.tag_id)
			  )))
		) ELSE (
			SELECT count(*) FROM assets a
			WHERE a.deleted_at IS NULL AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) AND a.origin='library' AND a.type IN('image','video') AND a.processing_status='ready'
			  AND EXISTS(SELECT 1 FROM asset_variants v WHERE v.asset_id=a.id AND v.deleted_at IS NULL AND v.player_compatible=TRUE)
			  AND EXISTS(SELECT 1 FROM playlist_draft_tags selected WHERE selected.playlist_id=p.id)
			  AND ((d.tag_match='any' AND EXISTS(
			       SELECT 1 FROM content_asset_tags at JOIN playlist_draft_tags selected ON selected.tag_id=at.tag_id
			       WHERE at.asset_id=a.id AND selected.playlist_id=p.id
			  )) OR (d.tag_match='all' AND NOT EXISTS(
			       SELECT 1 FROM playlist_draft_tags selected WHERE selected.playlist_id=p.id
			       AND NOT EXISTS(SELECT 1 FROM content_asset_tags at WHERE at.asset_id=a.id AND at.tag_id=selected.tag_id)
			  )))
		) END END
		FROM playlists p LEFT JOIN playlist_drafts d ON d.playlist_id=p.id
		WHERE p.deleted_at IS NULL AND p.system_managed=FALSE AND ($1='' OR COALESCE(d.name,p.name) ILIKE '%'||$1||'%')
		ORDER BY COALESCE(d.updated_at,p.updated_at) DESC,p.id LIMIT $2 OFFSET $3`, search, pageSize, (page-1)*pageSize)
	if err != nil {
		return ListResult{}, err
	}
	defer rows.Close()
	items := []Playlist{}
	for rows.Next() {
		var p Playlist
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.Revision, &p.DraftRevision, &p.HasUnpublishedChanges, &p.CreatedAt, &p.UpdatedAt, &p.SourceType, &p.ItemCount); err != nil {
			return ListResult{}, err
		}
		p.PublishedRevision = p.Revision
		p.Items = []Item{}
		p.Warnings = []string{}
		p.LayoutUsage = []LayoutUsage{}
		items = append(items, p)
	}
	return ListResult{Items: items, Total: total, Page: page, PageSize: pageSize}, rows.Err()
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Playlist, error) {
	var p Playlist
	var tagMatch string
	var tagImageDuration int64
	err := s.db.QueryRow(ctx, `SELECT id,name,description,revision,created_at,updated_at,source_type,tag_match,tag_image_duration_ms FROM playlists WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&p.ID, &p.Name, &p.Description, &p.Revision, &p.CreatedAt, &p.UpdatedAt, &p.SourceType, &tagMatch, &tagImageDuration)
	if errors.Is(err, pgx.ErrNoRows) {
		return Playlist{}, ErrNotFound
	}
	if err != nil {
		return Playlist{}, err
	}
	if p.SourceType == "tag" {
		p.TagRule = &TagRule{Match: tagMatch, ImageDurationMS: tagImageDuration, Tags: []PlaylistTag{}}
		tagRows, tagErr := s.db.Query(ctx, `SELECT t.id,t.name,t.color FROM playlist_tags pt JOIN content_tags t ON t.id=pt.tag_id WHERE pt.playlist_id=$1 ORDER BY lower(t.name),t.id`, id)
		if tagErr != nil {
			return Playlist{}, tagErr
		}
		for tagRows.Next() {
			var tag PlaylistTag
			if tagErr = tagRows.Scan(&tag.ID, &tag.Name, &tag.Color); tagErr != nil {
				tagRows.Close()
				return Playlist{}, tagErr
			}
			p.TagRule.Tags = append(p.TagRule.Tags, tag)
		}
		tagRows.Close()
		if tagErr = tagRows.Err(); tagErr != nil {
			return Playlist{}, tagErr
		}
	}
	itemQuery := `SELECT i.id,COALESCE(i.asset_id,'00000000-0000-0000-0000-000000000000'::uuid),i.layout_id,i.position,i.duration_ms,i.fit_mode,i.transition,i.audio_enabled,i.volume,i.video_start_offset_ms,i.video_end_offset_ms,i.delivery_policy,i.use_player_defaults,COALESCE(a.name,l.name),CASE WHEN i.layout_id IS NOT NULL THEN 'layout' ELSE a.type END,COALESCE(s.provider,''),CASE WHEN i.layout_id IS NOT NULL THEN CASE WHEN l.published_revision_id IS NOT NULL THEN 'ready' ELSE 'draft' END ELSE a.processing_status END,a.duration_seconds,v.id,i.created_at,i.updated_at,a.available_from,a.expires_at,FALSE FROM playlist_items i LEFT JOIN assets a ON a.id=i.asset_id LEFT JOIN layouts l ON l.id=i.layout_id AND l.deleted_at IS NULL LEFT JOIN widgets s ON s.asset_id=a.id LEFT JOIN LATERAL(SELECT id FROM asset_variants WHERE asset_id=a.id AND deleted_at IS NULL AND player_compatible=TRUE ORDER BY CASE kind WHEN 'playback' THEN 0 WHEN 'original' THEN 1 ELSE 2 END,id LIMIT 1)v ON TRUE WHERE i.playlist_id=$1 ORDER BY i.position`
	if p.SourceType == "tag" {
		itemQuery = `WITH matched AS (
			SELECT at.asset_id
			FROM content_asset_tags at JOIN playlist_tags pt ON pt.tag_id=at.tag_id
			WHERE pt.playlist_id=$1
			GROUP BY at.asset_id
			HAVING ($2='any' AND count(*)>0) OR ($2='all' AND count(*)=(SELECT count(*) FROM playlist_tags WHERE playlist_id=$1))
		)
		SELECT a.id,a.id,NULL::uuid,row_number() OVER(ORDER BY lower(a.name),a.id)-1,
			CASE WHEN a.type='image' THEN $3::bigint ELSE NULL::bigint END,
			'contain','none',TRUE,1,NULL::bigint,NULL::bigint,'download',FALSE,a.name,a.type,'',
			a.processing_status,a.duration_seconds,v.id,a.created_at,a.updated_at,a.available_from,a.expires_at,TRUE
		FROM matched m JOIN assets a ON a.id=m.asset_id
		LEFT JOIN LATERAL(SELECT id FROM asset_variants WHERE asset_id=a.id AND deleted_at IS NULL AND player_compatible=TRUE ORDER BY CASE kind WHEN 'playback' THEN 0 WHEN 'original' THEN 1 ELSE 2 END,id LIMIT 1)v ON TRUE
		WHERE a.deleted_at IS NULL AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) AND a.origin='library' AND a.type IN ('image','video') AND a.processing_status='ready' AND v.id IS NOT NULL
		ORDER BY lower(a.name),a.id`
	}
	var rows pgx.Rows
	if p.SourceType == "tag" {
		rows, err = s.db.Query(ctx, itemQuery, id, tagMatch, tagImageDuration)
	} else {
		rows, err = s.db.Query(ctx, itemQuery, id)
	}
	if err != nil {
		return Playlist{}, err
	}
	defer rows.Close()
	p.Items = []Item{}
	p.Warnings = []string{}
	p.LayoutUsage = []LayoutUsage{}
	for rows.Next() {
		var item Item
		if err := rows.Scan(&item.ID, &item.AssetID, &item.LayoutID, &item.Position, &item.DurationMS, &item.FitMode, &item.Transition, &item.AudioEnabled, &item.Volume, &item.VideoStartOffsetMS, &item.VideoEndOffsetMS, &item.DeliveryPolicy, &item.UsePlayerDefaults, &item.AssetName, &item.AssetType, &item.WidgetProvider, &item.AssetStatus, &item.AssetDurationSeconds, &item.VariantID, &item.CreatedAt, &item.UpdatedAt, &item.AvailableFrom, &item.ExpiresAt, &item.Dynamic); err != nil {
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
	if err = rows.Err(); err != nil {
		return Playlist{}, err
	}
	usageRows, err := s.db.Query(ctx, `
		SELECT l.id,l.name,bool_or(COALESCE(r.id=l.published_revision_id,FALSE))
		FROM layouts l
		LEFT JOIN layout_draft_dependencies d ON d.layout_id=l.id AND d.dependency_type='playlist' AND d.dependency_id=$1
		LEFT JOIN layout_revision_dependencies rd ON rd.dependency_type='playlist' AND rd.dependency_id=$1
		LEFT JOIN layout_revisions r ON r.id=rd.revision_id AND r.layout_id=l.id
		WHERE l.deleted_at IS NULL AND (d.layout_id IS NOT NULL OR r.id IS NOT NULL)
		GROUP BY l.id,l.name ORDER BY l.name`, id)
	if err != nil {
		return Playlist{}, err
	}
	defer usageRows.Close()
	for usageRows.Next() {
		var usage LayoutUsage
		if err = usageRows.Scan(&usage.ID, &usage.Name, &usage.Published); err != nil {
			return Playlist{}, err
		}
		p.LayoutUsage = append(p.LayoutUsage, usage)
	}
	if err = usageRows.Err(); err != nil {
		return Playlist{}, err
	}
	if p.Usage, err = s.usage(ctx, id); err != nil {
		return Playlist{}, err
	}
	if p.DataSourceIDs, err = s.reachableDataSources(ctx, id); err != nil {
		return Playlist{}, err
	}
	return p, nil
}

func (s *Service) SetTagRule(ctx context.Context, id, userID uuid.UUID, input TagRuleInput) (Playlist, error) {
	if input.Match == "" {
		input.Match = "any"
	}
	if input.Match != "any" && input.Match != "all" {
		return Playlist{}, errors.New("tag match must be any or all")
	}
	if input.ImageDurationMS == 0 {
		input.ImageDurationMS = 10000
	}
	if input.ImageDurationMS < 1000 || input.ImageDurationMS > 86400000 {
		return Playlist{}, errors.New("tag playlist image duration must be between 1 second and 24 hours")
	}
	if input.Enabled && (len(input.TagIDs) < 1 || len(input.TagIDs) > 20) {
		return Playlist{}, errors.New("tagIds must contain between 1 and 20 tags")
	}
	tagIDs := uniqueUUIDs(input.TagIDs)
	if input.Enabled && len(tagIDs) != len(input.TagIDs) {
		return Playlist{}, errors.New("tagIds must not contain duplicates")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer tx.Rollback(ctx)
	if input.Enabled {
		var count int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM content_tags WHERE id=ANY($1)`, tagIDs).Scan(&count); err != nil {
			return Playlist{}, err
		}
		if count != len(tagIDs) {
			return Playlist{}, ErrInvalidItem
		}
	}
	sourceType := "static"
	if input.Enabled {
		sourceType = "tag"
	}
	if err = ensureDraftTx(ctx, tx, id); err != nil {
		return Playlist{}, err
	}
	result, err := tx.Exec(ctx, `UPDATE playlist_drafts SET source_type=$2,tag_match=$3,tag_image_duration_ms=$4,revision=revision+1,updated_by=$5,updated_at=now() WHERE playlist_id=$1`, id, sourceType, input.Match, input.ImageDurationMS, userID)
	if err != nil {
		return Playlist{}, err
	}
	if result.RowsAffected() == 0 {
		return Playlist{}, ErrNotFound
	}
	if _, err = tx.Exec(ctx, `DELETE FROM playlist_draft_tags WHERE playlist_id=$1`, id); err != nil {
		return Playlist{}, err
	}
	for _, tagID := range tagIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO playlist_draft_tags(playlist_id,tag_id) VALUES($1,$2)`, id, tagID); err != nil {
			return Playlist{}, err
		}
	}
	if err = insertAudit(ctx, tx, userID, "playlist.draft.tag_rule_updated", id); err != nil {
		return Playlist{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Playlist{}, err
	}
	return s.GetDraft(ctx, id)
}

// reachableDataSources reports the Data Sources a playlist reaches through its items.
//
// A Widget references a Source whenever one of its configuration values is that Source's ID, the
// same rule the deletion check uses — matching any value rather than a fixed key covers Widgets
// that expose several Data Source selectors under arbitrary keys, and Source IDs are unique so it
// cannot collide with an unrelated value. A Layout placed in the playlist contributes its own
// stored dependencies, which already include Sources reached only through a text binding.
//
// Embedded Layouts contribute their draft dependencies, matching what Studio shows for a Layout
// assigned to a screen directly; the two legs would otherwise disagree about the same Layout.
func (s *Service) reachableDataSources(ctx context.Context, id uuid.UUID) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `
		SELECT ds.id FROM playlist_items i
		JOIN widgets w ON w.asset_id=i.asset_id
		CROSS JOIN LATERAL jsonb_each_text(w.configuration) field
		JOIN data_sources ds ON ds.id::text=field.value AND ds.deleted_at IS NULL
		WHERE i.playlist_id=$1
		UNION
		SELECT ds.id FROM playlist_items i
		JOIN layout_draft_dependencies d ON d.layout_id=i.layout_id AND d.dependency_type='data_source'
		JOIN data_sources ds ON ds.id=d.dependency_id AND ds.deleted_at IS NULL
		WHERE i.playlist_id=$1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []uuid.UUID{}
	for rows.Next() {
		var sourceID uuid.UUID
		if err = rows.Scan(&sourceID); err != nil {
			return nil, err
		}
		result = append(result, sourceID)
	}
	return result, rows.Err()
}

// usage reports the screens and schedules that play a playlist. Screens are reached either by a
// direct assignment or through a synchronized group, matching how the Layout usage read resolves
// the same question.
func (s *Service) usage(ctx context.Context, id uuid.UUID) (Usage, error) {
	result := Usage{Screens: []UsageItem{}, Schedules: []UsageItem{}, Campaigns: []UsageItem{}}
	screens, err := s.db.Query(ctx, `SELECT DISTINCT sc.id,sc.name FROM screens sc LEFT JOIN screen_playlist_assignments a ON a.screen_id=sc.id LEFT JOIN screen_group_memberships m ON m.screen_id=sc.id LEFT JOIN screen_group_playlist_assignments ga ON ga.screen_group_id=m.screen_group_id WHERE a.playlist_id=$1 OR ga.playlist_id=$1 ORDER BY sc.name`, id)
	if err != nil {
		return Usage{}, err
	}
	for screens.Next() {
		var item UsageItem
		if err = screens.Scan(&item.ID, &item.Name); err != nil {
			screens.Close()
			return Usage{}, err
		}
		result.Screens = append(result.Screens, item)
	}
	screens.Close()
	if err = screens.Err(); err != nil {
		return Usage{}, err
	}
	schedules, err := s.db.Query(ctx, `SELECT id,name FROM schedules WHERE playlist_id=$1 AND deleted_at IS NULL ORDER BY name`, id)
	if err != nil {
		return Usage{}, err
	}
	defer schedules.Close()
	for schedules.Next() {
		var item UsageItem
		if err = schedules.Scan(&item.ID, &item.Name); err != nil {
			return Usage{}, err
		}
		result.Schedules = append(result.Schedules, item)
	}
	if err = schedules.Err(); err != nil {
		return Usage{}, err
	}
	campaigns, err := s.db.Query(ctx, `SELECT DISTINCT c.id,c.name FROM campaigns c LEFT JOIN schedules s ON s.campaign_id=c.id AND s.playlist_id=$1 AND s.deleted_at IS NULL WHERE c.archived_at IS NULL AND (s.id IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.draft->'blocks') block WHERE block->>'contentType'='playlist' AND block->>'contentId'=$1::text)) ORDER BY c.name`, id)
	if err != nil {
		return Usage{}, err
	}
	defer campaigns.Close()
	for campaigns.Next() {
		var item UsageItem
		if err = campaigns.Scan(&item.ID, &item.Name); err != nil {
			return Usage{}, err
		}
		result.Campaigns = append(result.Campaigns, item)
	}
	return result, campaigns.Err()
}

func (s *Service) Update(ctx context.Context, id, userID uuid.UUID, name, description string) (Playlist, error) {
	name = strings.TrimSpace(name)
	description = strings.TrimSpace(description)
	if err := validateDetails(name, description); err != nil {
		return Playlist{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer tx.Rollback(ctx)
	if err = ensureDraftTx(ctx, tx, id); err != nil {
		return Playlist{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE playlist_drafts SET name=$2,description=$3,revision=revision+1,updated_by=$4,updated_at=now() WHERE playlist_id=$1`, id, name, description, userID)
	if err != nil {
		return Playlist{}, err
	}
	if tag.RowsAffected() == 0 {
		return Playlist{}, ErrNotFound
	}
	if err = insertAudit(ctx, tx, userID, "playlist.draft.updated", id); err != nil {
		return Playlist{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Playlist{}, err
	}
	return s.GetDraft(ctx, id)
}

func (s *Service) Duplicate(ctx context.Context, id, userID uuid.UUID) (Playlist, error) {
	source, err := s.GetDraft(ctx, id)
	if err != nil {
		return Playlist{}, err
	}
	created, err := s.Create(ctx, userID, source.Name+" copy", source.Description, source.SourceType)
	if err != nil {
		return Playlist{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `UPDATE playlist_drafts SET source_type=$2,tag_match=$3,tag_image_duration_ms=$4,revision=revision+1,updated_by=$5,updated_at=now() WHERE playlist_id=$1`, created.ID, source.SourceType, func() string {
		if source.TagRule != nil {
			return source.TagRule.Match
		}
		return "any"
	}(), func() int64 {
		if source.TagRule != nil {
			return source.TagRule.ImageDurationMS
		}
		return int64(10000)
	}(), userID)
	if err != nil {
		return Playlist{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO playlist_draft_items(id,playlist_id,asset_id,layout_id,position,duration_ms,fit_mode,transition,audio_enabled,volume,video_start_offset_ms,video_end_offset_ms,delivery_policy,use_player_defaults) SELECT gen_random_uuid(),$2,asset_id,layout_id,position,duration_ms,fit_mode,transition,audio_enabled,volume,video_start_offset_ms,video_end_offset_ms,delivery_policy,use_player_defaults FROM playlist_draft_items WHERE playlist_id=$1`, id, created.ID); err != nil {
		return Playlist{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO playlist_draft_tags(playlist_id,tag_id) SELECT $2,tag_id FROM playlist_draft_tags WHERE playlist_id=$1`, id, created.ID); err != nil {
		return Playlist{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Playlist{}, err
	}
	return s.GetDraft(ctx, created.ID)
}

func (s *Service) Delete(ctx context.Context, id, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var assigned int
	if err = tx.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM screen_playlist_assignments WHERE playlist_id=$1)+
		(SELECT count(*) FROM schedules WHERE playlist_id=$1 AND deleted_at IS NULL)+
		(SELECT count(*) FROM layout_draft_dependencies WHERE dependency_type='playlist' AND dependency_id=$1)+
		(SELECT count(*) FROM layout_revision_dependencies WHERE dependency_type='playlist' AND dependency_id=$1)`, id).Scan(&assigned); err != nil {
		return err
	}
	if assigned > 0 {
		return fmt.Errorf("%w: playlist is assigned or required by a Layout", ErrConflict)
	}
	tag, err := tx.Exec(ctx, `UPDATE playlists SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err = insertAudit(ctx, tx, userID, "playlist.deleted", id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type assetInfo struct {
	Type     string
	Provider string
	Duration *float64
	Variant  *uuid.UUID
}

func (s *Service) validateItem(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, input ItemInput) (ItemInput, assetInfo, error) {
	if (input.AssetID == uuid.Nil) == (input.LayoutID == nil) {
		return input, assetInfo{}, errors.New("playlist item must reference exactly one asset or Layout")
	}
	if input.LayoutID != nil {
		input = normalizeItemDefaults(input, "layout")
		var published bool
		err := q.QueryRow(ctx, `SELECT published_revision_id IS NOT NULL FROM layouts WHERE id=$1 AND deleted_at IS NULL`, *input.LayoutID).Scan(&published)
		if errors.Is(err, pgx.ErrNoRows) || !published {
			return input, assetInfo{}, errors.New("Layout must be published before it can be added")
		}
		if err != nil {
			return input, assetInfo{}, err
		}
		if input.DurationMS == nil || *input.DurationMS <= 0 {
			return input, assetInfo{}, errors.New("Layout durationMs must be positive")
		}
		input.DeliveryPolicy = "stream"
		input.VideoStartOffsetMS, input.VideoEndOffsetMS = nil, nil
		off, zero := false, 0.0
		input.AudioEnabled, input.Volume, input.UsePlayerDefaults = &off, &zero, false
		return input, assetInfo{Type: "layout"}, nil
	}
	var a assetInfo
	err := q.QueryRow(ctx, `SELECT a.type,COALESCE(s.provider,''),a.duration_seconds,v.id FROM assets a LEFT JOIN widgets s ON s.asset_id=a.id LEFT JOIN LATERAL(SELECT id FROM asset_variants WHERE asset_id=a.id AND deleted_at IS NULL AND player_compatible=TRUE ORDER BY CASE kind WHEN 'playback' THEN 0 ELSE 1 END,id LIMIT 1)v ON TRUE WHERE a.id=$1 AND a.deleted_at IS NULL AND a.processing_status='ready' AND (a.type='widget' OR v.id IS NOT NULL)`, input.AssetID).Scan(&a.Type, &a.Provider, &a.Duration, &a.Variant)
	if errors.Is(err, pgx.ErrNoRows) {
		return input, a, ErrInvalidAsset
	}
	if err != nil {
		return input, a, err
	}
	var defaultsErr error
	input, defaultsErr = normalizeItemDefaultsWithOrganization(ctx, q, input, a.Type)
	if defaultsErr != nil {
		return input, a, defaultsErr
	}
	if input.FitMode != "contain" && input.FitMode != "cover" && input.FitMode != "stretch" {
		return input, a, errors.New("fitMode must be contain, cover, or stretch")
	}
	if input.Transition != "none" && input.Transition != "fade" && input.Transition != "crossfade" {
		return input, a, errors.New("transition must be none, fade, or crossfade")
	}
	if input.DeliveryPolicy != "download" && input.DeliveryPolicy != "stream" && input.DeliveryPolicy != "automatic" {
		return input, a, errors.New("deliveryPolicy must be download, stream, or automatic")
	}
	if input.Volume == nil || *input.Volume < 0 || *input.Volume > 1 {
		return input, a, errors.New("volume must be between 0 and 1")
	}
	if a.Type == "image" && (input.DurationMS == nil || *input.DurationMS <= 0) && !input.UsePlayerDefaults {
		return input, a, errors.New("image durationMs must be positive")
	}
	if a.Type == "widget" {
		if input.DurationMS == nil || *input.DurationMS <= 0 {
			if a.Provider == "website" {
				return input, a, errors.New("website source durationMs must be positive")
			}
		}
		input.DeliveryPolicy = "stream"
		input.VideoStartOffsetMS = nil
		input.VideoEndOffsetMS = nil
		off := false
		input.AudioEnabled = &off
		zero := 0.0
		input.Volume, input.UsePlayerDefaults = &zero, false
	}
	if a.Type == "video" {
		durationMS := int64(0)
		if a.Duration != nil {
			durationMS = int64(*a.Duration * 1000)
		}
		start := int64(0)
		if input.VideoStartOffsetMS != nil {
			start = *input.VideoStartOffsetMS
		}
		if start < 0 || (durationMS > 0 && start >= durationMS) {
			return input, a, errors.New("video start offset is outside the asset duration")
		}
		if input.VideoEndOffsetMS != nil {
			if *input.VideoEndOffsetMS <= start || (durationMS > 0 && *input.VideoEndOffsetMS > durationMS) {
				return input, a, errors.New("video end offset must be after the start and within the asset duration")
			}
		}
	}
	return input, a, nil
}

// normalizeItemDefaults applies organization-level authoring defaults only
// when the caller omitted a field. A media item that explicitly opts into
// Player defaults carries that choice through the manifest; its stored values
// remain a valid fallback for older Players.
func normalizeItemDefaults(input ItemInput, assetType string) ItemInput {
	if input.FitMode == "" {
		input.FitMode = "contain"
	}
	if input.Transition == "" {
		input.Transition = "none"
	}
	if input.DeliveryPolicy == "" {
		input.DeliveryPolicy = "download"
	}
	if input.AudioEnabled == nil {
		v := true
		input.AudioEnabled = &v
	}
	if input.Volume == nil {
		v := 1.0
		input.Volume = &v
	}
	if assetType != "image" && assetType != "video" {
		input.UsePlayerDefaults = false
	}
	return input
}

func normalizeItemDefaultsWithOrganization(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, input ItemInput, assetType string) (ItemInput, error) {
	fitOmitted := input.FitMode == ""
	transitionOmitted := input.Transition == ""
	deliveryOmitted := input.DeliveryPolicy == ""
	audioOmitted := input.AudioEnabled == nil
	input = normalizeItemDefaults(input, assetType)
	if fitOmitted {
		key := ""
		if assetType == "image" {
			key = "media.image.default_fit_mode"
		} else if assetType == "video" {
			key = "media.video.default_fit_mode"
		}
		if key != "" {
			value, err := organizationSettingText(ctx, q, key, input.FitMode)
			if err != nil {
				return input, err
			}
			input.FitMode = value
		}
	}
	if transitionOmitted {
		value, err := organizationSettingText(ctx, q, "player.playback.default_transition", input.Transition)
		if err != nil {
			return input, err
		}
		input.Transition = value
	}
	if deliveryOmitted && assetType == "video" {
		value, err := organizationSettingText(ctx, q, "media.video.default_delivery_policy", input.DeliveryPolicy)
		if err != nil {
			return input, err
		}
		input.DeliveryPolicy = value
	}
	if audioOmitted {
		value, err := organizationSettingText(ctx, q, "player.playback.default_audio_enabled", "true")
		if err != nil {
			return input, err
		}
		audio := value == "true"
		input.AudioEnabled = &audio
	}
	// An omitted image duration resolves to the organization default instead
	// of failing validation. Explicit non-positive durations still fail below,
	// and callers that opt into Player defaults keep a nil duration.
	if assetType == "image" && input.DurationMS == nil && !input.UsePlayerDefaults {
		var defaultMS int64
		if err := q.QueryRow(ctx, `SELECT COALESCE((SELECT round((settings->>'player.playback.default_image_duration_seconds')::numeric*1000)::bigint FROM organization_runtime_settings LIMIT 1),10000)`).Scan(&defaultMS); err != nil {
			return input, err
		}
		input.DurationMS = &defaultMS
	}
	return input, nil
}

func organizationSettingText(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, key, fallback string) (string, error) {
	var value *string
	err := q.QueryRow(ctx, `SELECT settings->>$1 FROM organization_runtime_settings LIMIT 1`, key).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) || value == nil || *value == "" {
		return fallback, nil
	}
	if key == "player.playback.default_audio_enabled" {
		if _, parseErr := strconv.ParseBool(*value); parseErr != nil {
			return fallback, nil
		}
	}
	return *value, nil
}

func validateLayoutItemCycle(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, playlistID uuid.UUID, layoutID *uuid.UUID) error {
	if layoutID == nil {
		return nil
	}
	var reachesPlaylist bool
	err := q.QueryRow(ctx, `
		WITH RECURSIVE refs(kind,id) AS (
			SELECT 'layout', $1::uuid
			UNION
			SELECT next.kind,next.id
			FROM refs ref
			CROSS JOIN LATERAL (
				SELECT 'playlist'::text AS kind,dependency.dependency_id AS id
				FROM layouts layout
				JOIN layout_revision_dependencies dependency
				  ON dependency.revision_id=layout.published_revision_id
				 AND dependency.dependency_type='playlist'
				WHERE ref.kind='layout' AND layout.id=ref.id
				UNION
				SELECT 'layout'::text,item.layout_id
				FROM playlist_draft_items item
				WHERE ref.kind='playlist' AND item.playlist_id=ref.id AND item.layout_id IS NOT NULL
			) next
		)
		SELECT EXISTS(SELECT 1 FROM refs WHERE kind='playlist' AND id=$2)`,
		*layoutID, playlistID).Scan(&reachesPlaylist)
	if err != nil {
		return err
	}
	if reachesPlaylist {
		return errors.New("Layout cannot be added because it contains this playlist")
	}
	return nil
}

func (s *Service) AddItem(ctx context.Context, playlistID, userID uuid.UUID, input ItemInput) (Playlist, error) {
	if err := s.requireStaticPlaylist(ctx, playlistID); err != nil {
		return Playlist{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	if err = validateLayoutItemCycle(ctx, tx, playlistID, input.LayoutID); err != nil {
		return Playlist{}, err
	}
	defer tx.Rollback(ctx)
	input, _, err = s.validateItem(ctx, tx, input)
	if err != nil {
		return Playlist{}, err
	}
	if err = ensureDraftTx(ctx, tx, playlistID); err != nil {
		return Playlist{}, err
	}
	var position int
	if err = tx.QueryRow(ctx, `SELECT COALESCE(max(position)+1,0) FROM playlist_draft_items WHERE playlist_id=$1`, playlistID).Scan(&position); err != nil {
		return Playlist{}, err
	}
	var draftRevision int64
	err = tx.QueryRow(ctx, `UPDATE playlist_drafts SET revision=revision+1,updated_by=$2,updated_at=now() WHERE playlist_id=$1 RETURNING revision`, playlistID, userID).Scan(&draftRevision)
	if err != nil {
		return Playlist{}, err
	}
	var assetID any = input.AssetID
	if input.LayoutID != nil {
		assetID = nil
	}
	_, err = tx.Exec(ctx, `INSERT INTO playlist_draft_items(id,playlist_id,asset_id,layout_id,position,duration_ms,fit_mode,transition,audio_enabled,volume,video_start_offset_ms,video_end_offset_ms,delivery_policy,use_player_defaults)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, uuid.New(), playlistID, assetID, input.LayoutID, position, input.DurationMS, input.FitMode, input.Transition, *input.AudioEnabled, *input.Volume, input.VideoStartOffsetMS, input.VideoEndOffsetMS, input.DeliveryPolicy, input.UsePlayerDefaults)
	if err != nil {
		return Playlist{}, err
	}
	_ = draftRevision
	if err = insertAudit(ctx, tx, userID, "playlist.draft.item_added", playlistID); err != nil {
		return Playlist{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Playlist{}, err
	}
	return s.GetDraft(ctx, playlistID)
}

func validateBulkItemInput(input BulkItemInput) error {
	if (input.Transition == nil) == (input.DurationMS == nil) {
		return errors.New("bulk playlist update must set exactly one field")
	}
	if input.Transition != nil && *input.Transition != "none" && *input.Transition != "fade" && *input.Transition != "crossfade" {
		return errors.New("transition must be none, fade, or crossfade")
	}
	if input.DurationMS != nil && *input.DurationMS <= 0 {
		return errors.New("image durationMs must be positive")
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range input.ItemIDs {
		if id == uuid.Nil {
			return errors.New("itemIds must contain valid item IDs")
		}
		if seen[id] {
			return errors.New("itemIds contains a duplicate")
		}
		seen[id] = true
	}
	return nil
}

// BulkUpdateItems applies an authoring-level playback default to a static
// playlist. The stored item values are updated deliberately: this is an
// explicit playlist edit, so it must take precedence over Player defaults.
func (s *Service) BulkUpdateItems(ctx context.Context, playlistID, userID uuid.UUID, input BulkItemInput) (Playlist, error) {
	if err := s.requireStaticPlaylist(ctx, playlistID); err != nil {
		return Playlist{}, err
	}
	if err := validateBulkItemInput(input); err != nil {
		return Playlist{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer tx.Rollback(ctx)

	if len(input.ItemIDs) > 0 {
		var count int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM playlist_draft_items WHERE playlist_id=$1 AND id=ANY($2::uuid[])`, playlistID, input.ItemIDs).Scan(&count); err != nil {
			return Playlist{}, err
		}
		if count != len(input.ItemIDs) {
			return Playlist{}, errors.New("itemIds contains an unknown playlist item")
		}
	}

	var tag pgconn.CommandTag
	if input.Transition != nil {
		var defaultImageDurationMS int64
		if err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT round((settings->>'player.playback.default_image_duration_seconds')::numeric*1000)::bigint FROM organization_runtime_settings LIMIT 1),10000)`).Scan(&defaultImageDurationMS); err != nil {
			return Playlist{}, err
		}
		if len(input.ItemIDs) == 0 {
			tag, err = tx.Exec(ctx, `UPDATE playlist_draft_items item SET transition=$2,duration_ms=CASE WHEN item.duration_ms IS NULL AND EXISTS(SELECT 1 FROM assets image WHERE image.id=item.asset_id AND image.type='image') THEN $3 ELSE item.duration_ms END,use_player_defaults=FALSE,updated_at=now() WHERE item.playlist_id=$1`, playlistID, *input.Transition, defaultImageDurationMS)
		} else {
			tag, err = tx.Exec(ctx, `UPDATE playlist_draft_items item SET transition=$3,duration_ms=CASE WHEN item.duration_ms IS NULL AND EXISTS(SELECT 1 FROM assets image WHERE image.id=item.asset_id AND image.type='image') THEN $4 ELSE item.duration_ms END,use_player_defaults=FALSE,updated_at=now() WHERE item.playlist_id=$1 AND item.id=ANY($2::uuid[])`, playlistID, input.ItemIDs, *input.Transition, defaultImageDurationMS)
		}
	} else if len(input.ItemIDs) == 0 {
		tag, err = tx.Exec(ctx, `UPDATE playlist_draft_items item SET duration_ms=$2,use_player_defaults=FALSE,updated_at=now() FROM assets asset WHERE item.playlist_id=$1 AND asset.id=item.asset_id AND asset.type='image'`, playlistID, *input.DurationMS)
	} else {
		tag, err = tx.Exec(ctx, `UPDATE playlist_draft_items item SET duration_ms=$3,use_player_defaults=FALSE,updated_at=now() FROM assets asset WHERE item.playlist_id=$1 AND item.id=ANY($2::uuid[]) AND asset.id=item.asset_id AND asset.type='image'`, playlistID, input.ItemIDs, *input.DurationMS)
	}
	if err != nil {
		return Playlist{}, err
	}
	if tag.RowsAffected() > 0 {
		if _, err = bumpDraftTx(ctx, tx, playlistID, userID); err != nil {
			return Playlist{}, err
		}
		if err = insertAudit(ctx, tx, userID, "playlist.draft.items_bulk_updated", playlistID); err != nil {
			return Playlist{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Playlist{}, err
	}
	return s.GetDraft(ctx, playlistID)
}

func (s *Service) UpdateItem(ctx context.Context, playlistID, itemID, userID uuid.UUID, input ItemInput) (Playlist, error) {
	if err := s.requireStaticPlaylist(ctx, playlistID); err != nil {
		return Playlist{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer tx.Rollback(ctx)
	input, _, err = s.validateItem(ctx, tx, input)
	if err != nil {
		return Playlist{}, err
	}
	if err = validateLayoutItemCycle(ctx, tx, playlistID, input.LayoutID); err != nil {
		return Playlist{}, err
	}
	var assetID any = input.AssetID
	if input.LayoutID != nil {
		assetID = nil
	}
	tag, err := tx.Exec(ctx, `UPDATE playlist_draft_items SET asset_id=$3,layout_id=$4,duration_ms=$5,fit_mode=$6,transition=$7,audio_enabled=$8,volume=$9,video_start_offset_ms=$10,video_end_offset_ms=$11,delivery_policy=$12,use_player_defaults=$13,updated_at=now() WHERE playlist_id=$1 AND id=$2`, playlistID, itemID, assetID, input.LayoutID, input.DurationMS, input.FitMode, input.Transition, *input.AudioEnabled, *input.Volume, input.VideoStartOffsetMS, input.VideoEndOffsetMS, input.DeliveryPolicy, input.UsePlayerDefaults)
	if err != nil {
		return Playlist{}, err
	}
	if tag.RowsAffected() == 0 {
		return Playlist{}, ErrNotFound
	}
	if _, err = bumpDraftTx(ctx, tx, playlistID, userID); err != nil {
		return Playlist{}, err
	}
	if err = insertAudit(ctx, tx, userID, "playlist.draft.item_updated", playlistID); err != nil {
		return Playlist{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Playlist{}, err
	}
	return s.GetDraft(ctx, playlistID)
}

func (s *Service) DeleteItem(ctx context.Context, playlistID, itemID, userID uuid.UUID) (Playlist, error) {
	if err := s.requireStaticPlaylist(ctx, playlistID); err != nil {
		return Playlist{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM playlist_draft_items WHERE playlist_id=$1 AND id=$2`, playlistID, itemID)
	if err != nil {
		return Playlist{}, err
	}
	if tag.RowsAffected() == 0 {
		return Playlist{}, ErrNotFound
	}
	if _, err = tx.Exec(ctx, `UPDATE playlist_draft_items SET position=position+1000000 WHERE playlist_id=$1`, playlistID); err != nil {
		return Playlist{}, err
	}
	if _, err = tx.Exec(ctx, `WITH ranked AS(SELECT id,row_number()OVER(ORDER BY position)-1 p FROM playlist_draft_items WHERE playlist_id=$1)UPDATE playlist_draft_items i SET position=r.p FROM ranked r WHERE i.id=r.id`, playlistID); err != nil {
		return Playlist{}, err
	}
	if _, err = bumpDraftTx(ctx, tx, playlistID, userID); err != nil {
		return Playlist{}, err
	}
	if err = insertAudit(ctx, tx, userID, "playlist.draft.item_deleted", playlistID); err != nil {
		return Playlist{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Playlist{}, err
	}
	return s.GetDraft(ctx, playlistID)
}

func (s *Service) Reorder(ctx context.Context, playlistID, userID uuid.UUID, ids []uuid.UUID) (Playlist, error) {
	if err := s.requireStaticPlaylist(ctx, playlistID); err != nil {
		return Playlist{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer tx.Rollback(ctx)
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM playlist_draft_items WHERE playlist_id=$1`, playlistID).Scan(&count); err != nil {
		return Playlist{}, err
	}
	if len(ids) != count {
		return Playlist{}, errors.New("item order must contain every playlist item exactly once")
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range ids {
		if seen[id] {
			return Playlist{}, errors.New("item order contains a duplicate")
		}
		seen[id] = true
	}
	if _, err = tx.Exec(ctx, `UPDATE playlist_draft_items SET position=position+1000000 WHERE playlist_id=$1`, playlistID); err != nil {
		return Playlist{}, err
	}
	for position, id := range ids {
		tag, e := tx.Exec(ctx, `UPDATE playlist_draft_items SET position=$3,updated_at=now() WHERE playlist_id=$1 AND id=$2`, playlistID, id, position)
		if e != nil {
			return Playlist{}, e
		}
		if tag.RowsAffected() != 1 {
			return Playlist{}, errors.New("item order contains an unknown item")
		}
	}
	if _, err = bumpDraftTx(ctx, tx, playlistID, userID); err != nil {
		return Playlist{}, err
	}
	if err = insertAudit(ctx, tx, userID, "playlist.draft.reordered", playlistID); err != nil {
		return Playlist{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Playlist{}, err
	}
	return s.GetDraft(ctx, playlistID)
}

func (s *Service) requireStaticPlaylist(ctx context.Context, id uuid.UUID) error {
	var sourceType string
	if err := s.db.QueryRow(ctx, `SELECT d.source_type FROM playlist_drafts d JOIN playlists p ON p.id=d.playlist_id WHERE d.playlist_id=$1 AND p.deleted_at IS NULL`, id).Scan(&sourceType); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if sourceType != "static" {
		return fmt.Errorf("%w: tag-driven playlist items are managed by their tag rule", ErrConflict)
	}
	return nil
}

type notification struct {
	screen  uuid.UUID
	version int64
}

func bumpAssigned(ctx context.Context, tx pgx.Tx, playlistID uuid.UUID, reason string) ([]notification, error) {
	return bumpResourcesInTx(ctx, tx, "playlist", playlistID, reason)
}

func bumpAssignmentScreens(ctx context.Context, tx pgx.Tx, screenID uuid.UUID, reason string) ([]notification, error) {
	rows, err := tx.Query(ctx, `WITH affected AS (SELECT members.screen_id FROM screen_group_memberships selected JOIN screen_group_memberships members ON members.screen_group_id=selected.screen_group_id WHERE selected.screen_id=$1 UNION SELECT $1 WHERE NOT EXISTS(SELECT 1 FROM screen_group_memberships WHERE screen_id=$1)) INSERT INTO screen_manifest_state(screen_id,manifest_version,previous_manifest_version,changed_at,change_reason) SELECT screen_id,1,NULL::bigint,now(),$2 FROM affected ON CONFLICT(screen_id)DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2 RETURNING screen_id,manifest_version`, screenID, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notes := []notification{}
	for rows.Next() {
		var note notification
		if err = rows.Scan(&note.screen, &note.version); err != nil {
			return nil, err
		}
		notes = append(notes, note)
	}
	return notes, rows.Err()
}

func bumpGroupAssignmentScreens(ctx context.Context, tx pgx.Tx, groupID uuid.UUID, reason string) ([]notification, error) {
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,previous_manifest_version,changed_at,change_reason) SELECT screen_id,1,NULL::bigint,now(),$2 FROM screen_group_memberships WHERE screen_group_id=$1 ON CONFLICT(screen_id)DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2 RETURNING screen_id,manifest_version`, groupID, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notes := []notification{}
	for rows.Next() {
		var note notification
		if err = rows.Scan(&note.screen, &note.version); err != nil {
			return nil, err
		}
		notes = append(notes, note)
	}
	return notes, rows.Err()
}
func (s *Service) notify(items []notification) {
	if s.notifier == nil {
		return
	}
	for _, n := range items {
		s.notifier.ManifestChanged(n.screen, n.version)
	}
}

func (s *Service) NotifyManifestChanges(changes []manifestchanges.Change) {
	if s.notifier == nil {
		return
	}
	for _, change := range changes {
		s.notifier.ManifestChanged(change.ScreenID, change.Version)
	}
}

func manifestChanges(notes []notification) []manifestchanges.Change {
	changes := make([]manifestchanges.Change, 0, len(notes))
	for _, note := range notes {
		changes = append(changes, manifestchanges.Change{ScreenID: note.screen, Version: note.version})
	}
	return changes
}

func (s *Service) Assign(ctx context.Context, screenID, playlistID, userID uuid.UUID) (Assignment, error) {
	return s.AssignPresentation(ctx, screenID, &playlistID, nil, userID)
}

func (s *Service) AssignPresentation(ctx context.Context, screenID uuid.UUID, playlistID, layoutID *uuid.UUID, userID uuid.UUID) (Assignment, error) {
	if (playlistID == nil) == (layoutID == nil) {
		return Assignment{}, errors.New("assignment requires exactly one presentation")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer tx.Rollback(ctx)
	// Review is checked here rather than in the HTTP layer so single
	// assignment, bulk assignment, and anything added later all pass through
	// it. The gate is nil unless the approval feature is wired in.
	//
	// Inside the transaction, and before anything is written: the gate locks the
	// content against a concurrent edit, and an edit that arrives now waits for
	// this assignment rather than slipping between the check and the commit.
	if err := s.passApprovalGate(ctx, tx, playlistID, layoutID); err != nil {
		return Assignment{}, err
	}
	contentType, contentID := "layout", layoutID
	if playlistID != nil {
		contentType, contentID = "playlist", playlistID
	}
	if err = s.ValidatePresentationInTx(ctx, tx, contentType, *contentID, time.Now().UTC()); err != nil {
		return Assignment{}, err
	}
	var exists bool
	if playlistID != nil {
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM playlists WHERE id=$1 AND deleted_at IS NULL)`, playlistID).Scan(&exists)
	} else {
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM layouts WHERE id=$1 AND deleted_at IS NULL AND published_revision_id IS NOT NULL)`, layoutID).Scan(&exists)
	}
	if err != nil {
		return Assignment{}, err
	}
	if !exists {
		return Assignment{}, ErrNotFound
	}
	var groupID *uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT m.screen_group_id FROM screens sc LEFT JOIN screen_group_memberships m ON m.screen_id=sc.id WHERE sc.id=$1`, screenID).Scan(&groupID); err != nil {
		return Assignment{}, err
	}
	targetScreens := []uuid.UUID{screenID}
	if groupID != nil {
		rows, queryErr := tx.Query(ctx, `SELECT screen_id FROM screen_group_memberships WHERE screen_group_id=$1 ORDER BY screen_id`, *groupID)
		if queryErr != nil {
			return Assignment{}, queryErr
		}
		targetScreens = targetScreens[:0]
		for rows.Next() {
			var target uuid.UUID
			if queryErr = rows.Scan(&target); queryErr != nil {
				rows.Close()
				return Assignment{}, queryErr
			}
			targetScreens = append(targetScreens, target)
		}
		if queryErr = rows.Err(); queryErr != nil {
			rows.Close()
			return Assignment{}, queryErr
		}
		rows.Close()
	}
	if err = s.validatePresentationForScreens(ctx, tx, playlistID, layoutID, targetScreens); err != nil {
		return Assignment{}, err
	}
	requiresV12, err := presentationRequiresManifestV12(ctx, tx, playlistID, layoutID)
	if err != nil {
		return Assignment{}, err
	}
	if requiresV12 {
		var incompatible bool
		if groupID != nil {
			err = tx.QueryRow(ctx, `SELECT EXISTS(
				SELECT 1 FROM screen_group_memberships m
				LEFT JOIN screen_player_status ps ON ps.screen_id=m.screen_id
				WHERE m.screen_group_id=$1 AND COALESCE(ps.player_version_code,0)<22
			)`, *groupID).Scan(&incompatible)
		} else {
			err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT player_version_code FROM screen_player_status WHERE screen_id=$1),0)<22`, screenID).Scan(&incompatible)
		}
		if err != nil {
			return Assignment{}, err
		}
		if incompatible {
			return Assignment{}, fmt.Errorf("%w: Player update required before assigning content that uses manifest v12", ErrConflict)
		}
	}
	if groupID != nil {
		_, err = tx.Exec(ctx, `INSERT INTO screen_group_playlist_assignments(screen_group_id,playlist_id,layout_id,assigned_by)VALUES($1,$2,$3,$4) ON CONFLICT(screen_group_id)DO UPDATE SET playlist_id=EXCLUDED.playlist_id,layout_id=EXCLUDED.layout_id,assigned_by=EXCLUDED.assigned_by,updated_at=now()`, *groupID, playlistID, layoutID, userID)
		if err == nil {
			_, err = tx.Exec(ctx, `DELETE FROM screen_playlist_assignments WHERE screen_id IN(SELECT screen_id FROM screen_group_memberships WHERE screen_group_id=$1)`, *groupID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE screen_groups SET playback_epoch=now(),updated_at=now() WHERE id=$1`, *groupID)
		}
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,layout_id,assigned_by)VALUES($1,$2,$3,$4,$5) ON CONFLICT(screen_id)DO UPDATE SET playlist_id=EXCLUDED.playlist_id,layout_id=EXCLUDED.layout_id,assigned_by=EXCLUDED.assigned_by,updated_at=now()`, uuid.New(), screenID, playlistID, layoutID, userID)
	}
	if err != nil {
		return Assignment{}, err
	}
	notes, err := bumpAssignmentScreens(ctx, tx, screenID, "assignment.changed")
	if err != nil {
		return Assignment{}, err
	}
	action := "screen.playlist_assigned"
	if layoutID != nil {
		action = "screen.layout_assigned"
	}
	if err = insertAudit(ctx, tx, userID, action, screenID); err != nil {
		return Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	s.notify(notes)
	return s.Assignment(ctx, screenID)
}
func (s *Service) Unassign(ctx context.Context, screenID, userID uuid.UUID) (Assignment, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer tx.Rollback(ctx)
	var groupID *uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT m.screen_group_id FROM screens sc LEFT JOIN screen_group_memberships m ON m.screen_id=sc.id WHERE sc.id=$1`, screenID).Scan(&groupID); err != nil {
		return Assignment{}, err
	}
	if groupID != nil {
		_, err = tx.Exec(ctx, `DELETE FROM screen_group_playlist_assignments WHERE screen_group_id=$1`, *groupID)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE screen_groups SET playback_epoch=now(),updated_at=now() WHERE id=$1`, *groupID)
		}
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM screen_playlist_assignments WHERE screen_id=$1`, screenID)
	}
	if err != nil {
		return Assignment{}, err
	}
	notes, err := bumpAssignmentScreens(ctx, tx, screenID, "assignment.removed")
	if err != nil {
		return Assignment{}, err
	}
	if err = insertAudit(ctx, tx, userID, "screen.playlist_unassigned", screenID); err != nil {
		return Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	s.notify(notes)
	return s.Assignment(ctx, screenID)
}

func (s *Service) AssignGroup(ctx context.Context, groupID, playlistID, userID uuid.UUID) error {
	return s.AssignGroupPresentation(ctx, groupID, &playlistID, nil, userID)
}

func (s *Service) AssignGroupPresentation(ctx context.Context, groupID uuid.UUID, playlistID, layoutID *uuid.UUID, userID uuid.UUID) error {
	if (playlistID == nil) == (layoutID == nil) {
		return errors.New("assignment requires exactly one presentation")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// A sync group assignment reaches every screen in the group, so it is an
	// assignment path like any other and passes the same gate, in the same
	// transaction.
	if err := s.passApprovalGate(ctx, tx, playlistID, layoutID); err != nil {
		return err
	}
	contentType, contentID := "layout", layoutID
	if playlistID != nil {
		contentType, contentID = "playlist", playlistID
	}
	if err = s.ValidatePresentationInTx(ctx, tx, contentType, *contentID, time.Now().UTC()); err != nil {
		return err
	}
	var valid bool
	if playlistID != nil {
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screen_groups g JOIN playlists p ON p.organization_id=g.organization_id WHERE g.id=$1 AND g.deleted_at IS NULL AND p.id=$2 AND p.deleted_at IS NULL)`, groupID, playlistID).Scan(&valid)
	} else {
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screen_groups g JOIN layouts l ON l.organization_id=g.organization_id WHERE g.id=$1 AND g.deleted_at IS NULL AND l.id=$2 AND l.deleted_at IS NULL AND l.published_revision_id IS NOT NULL)`, groupID, layoutID).Scan(&valid)
	}
	if err != nil {
		return err
	}
	if !valid {
		return ErrNotFound
	}
	rows, err := tx.Query(ctx, `SELECT screen_id FROM screen_group_memberships WHERE screen_group_id=$1 ORDER BY screen_id`, groupID)
	if err != nil {
		return err
	}
	targetScreens := []uuid.UUID{}
	for rows.Next() {
		var screenID uuid.UUID
		if err = rows.Scan(&screenID); err != nil {
			rows.Close()
			return err
		}
		targetScreens = append(targetScreens, screenID)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err = s.validatePresentationForScreens(ctx, tx, playlistID, layoutID, targetScreens); err != nil {
		return err
	}
	requiresV12, err := presentationRequiresManifestV12(ctx, tx, playlistID, layoutID)
	if err != nil {
		return err
	}
	if requiresV12 {
		var incompatible bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM screen_group_memberships m
			LEFT JOIN screen_player_status ps ON ps.screen_id=m.screen_id
			WHERE m.screen_group_id=$1 AND COALESCE(ps.player_version_code,0)<22
		)`, groupID).Scan(&incompatible); err != nil {
			return err
		}
		if incompatible {
			return fmt.Errorf("%w: Player update required before assigning content that uses manifest v12", ErrConflict)
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO screen_group_playlist_assignments(screen_group_id,playlist_id,layout_id,assigned_by)VALUES($1,$2,$3,$4) ON CONFLICT(screen_group_id)DO UPDATE SET playlist_id=EXCLUDED.playlist_id,layout_id=EXCLUDED.layout_id,assigned_by=EXCLUDED.assigned_by,updated_at=now()`, groupID, playlistID, layoutID, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE screen_groups SET playback_epoch=now(),updated_at=now() WHERE id=$1`, groupID); err != nil {
		return err
	}
	notes, err := bumpGroupAssignmentScreens(ctx, tx, groupID, "sync_group.assignment_changed")
	if err != nil {
		return err
	}
	action := "sync_group.playlist_assigned"
	if layoutID != nil {
		action = "sync_group.layout_assigned"
	}
	if err = insertAudit(ctx, tx, userID, action, groupID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

func presentationRequiresManifestV12(ctx context.Context, tx pgx.Tx, playlistID, layoutID *uuid.UUID) (bool, error) {
	if playlistID != nil {
		var required bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM playlist_items i
			JOIN widgets w ON w.asset_id=i.asset_id
			WHERE i.playlist_id=$1 AND (
				w.config_version>=2 OR w.provider IN('countdown','metric','cards','weather')
			)
		)`, *playlistID).Scan(&required)
		return required, err
	}
	var required bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM layouts l
		JOIN layout_revision_dependencies d ON d.revision_id=l.published_revision_id
		LEFT JOIN widgets w ON d.dependency_type='widget' AND w.asset_id=d.dependency_id
		LEFT JOIN data_sources ds ON d.dependency_type='data_source' AND ds.id=d.dependency_id
		WHERE l.id=$1 AND (
			w.config_version>=2 OR w.provider IN('countdown','metric','cards','weather')
			OR ds.provider IN('manual','weather')
		)
	)`, *layoutID).Scan(&required)
	return required, err
}

func (s *Service) UnassignGroup(ctx context.Context, groupID, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM screen_group_playlist_assignments WHERE screen_group_id=$1`, groupID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `UPDATE screen_groups SET playback_epoch=now(),updated_at=now() WHERE id=$1`, groupID); err != nil {
		return err
	}
	notes, err := bumpGroupAssignmentScreens(ctx, tx, groupID, "sync_group.assignment_removed")
	if err != nil {
		return err
	}
	if err = insertAudit(ctx, tx, userID, "sync_group.playlist_unassigned", groupID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

func (s *Service) Assignment(ctx context.Context, screenID uuid.UUID) (Assignment, error) {
	_, err := s.db.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id)VALUES($1) ON CONFLICT DO NOTHING`, screenID)
	if err != nil {
		return Assignment{}, err
	}
	var a Assignment
	a.ScreenID = screenID
	err = s.db.QueryRow(ctx, `SELECT COALESCE(ga.playlist_id,pa.playlist_id),p.name,p.revision,COALESCE(ga.layout_id,pa.layout_id),l.name,lr.revision,CASE WHEN COALESCE(ga.layout_id,pa.layout_id) IS NOT NULL THEN 'layout' WHEN COALESCE(ga.playlist_id,pa.playlist_id) IS NOT NULL THEN 'playlist' END,ms.manifest_version,ps.active_manifest_version,ps.pending_manifest_version,ps.download_queue_count,ps.downloaded_bytes,ps.required_bytes,ps.cache_used_bytes,ps.cache_limit_bytes,ps.current_item_id,ps.current_asset_id,ps.playback_state,ps.last_sync_error,ps.last_playback_error,ps.current_schedule_id,ps.current_playlist_id,ps.selection_source,ps.next_transition_at,ps.device_clock_offset_seconds,ps.schedule_evaluation_error,ps.schedule_manifest_version,ps.current_website_asset_id,ps.website_state,ps.website_load_started_at,ps.website_load_completed_at,ps.website_failure_category,ps.website_blocked_navigation_count,ps.website_current_host,ps.website_fallback_shown,ps.website_renderer_recovery_count FROM screen_manifest_state ms LEFT JOIN screen_group_memberships gm ON gm.screen_id=ms.screen_id LEFT JOIN screen_group_playlist_assignments ga ON ga.screen_group_id=gm.screen_group_id LEFT JOIN screen_playlist_assignments pa ON pa.screen_id=ms.screen_id LEFT JOIN playlists p ON p.id=COALESCE(ga.playlist_id,pa.playlist_id) LEFT JOIN layouts l ON l.id=COALESCE(ga.layout_id,pa.layout_id) LEFT JOIN layout_revisions lr ON lr.id=l.published_revision_id LEFT JOIN screen_player_status ps ON ps.screen_id=ms.screen_id WHERE ms.screen_id=$1`, screenID).Scan(&a.PlaylistID, &a.PlaylistName, &a.PlaylistRevision, &a.LayoutID, &a.LayoutName, &a.LayoutRevision, &a.PresentationType, &a.ManifestVersion, &a.PlayerActiveManifestVersion, &a.PlayerPendingManifestVersion, &a.DownloadQueueCount, &a.DownloadedBytes, &a.RequiredBytes, &a.CacheUsedBytes, &a.CacheLimitBytes, &a.CurrentItemID, &a.CurrentAssetID, &a.PlaybackState, &a.LastSyncError, &a.LastPlaybackError, &a.CurrentScheduleID, &a.CurrentPlaylistID, &a.SelectionSource, &a.NextTransitionAt, &a.DeviceClockOffsetSeconds, &a.ScheduleEvaluationError, &a.ScheduleManifestVersion, &a.CurrentWebsiteAssetID, &a.WebsiteState, &a.WebsiteLoadStartedAt, &a.WebsiteLoadCompletedAt, &a.WebsiteFailureCategory, &a.WebsiteBlockedNavigationCount, &a.WebsiteCurrentHost, &a.WebsiteFallbackShown, &a.WebsiteRendererRecoveryCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, ErrNotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	_ = s.db.QueryRow(ctx, `SELECT active_takeover_id,takeover_state,takeover_preparation_progress,playback_disabled,last_command_id,last_command_state,last_command_result,last_command_completed_at FROM screen_player_status WHERE screen_id=$1`, screenID).Scan(&a.ActiveTakeoverID, &a.TakeoverState, &a.TakeoverPreparationProgress, &a.PlaybackDisabled, &a.LastCommandID, &a.LastCommandState, &a.LastCommandResult, &a.LastCommandCompletedAt)
	_ = s.db.QueryRow(ctx, `SELECT active_config_revision,configuration_error FROM screen_player_status WHERE screen_id=$1`, screenID).Scan(&a.ActiveConfigRevision, &a.ConfigurationError)
	a.Groups = []AssignmentGroup{}
	groupRows, e := s.db.Query(ctx, `SELECT g.id,g.name FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id WHERE m.screen_id=$1 AND g.deleted_at IS NULL ORDER BY lower(g.name),g.id`, screenID)
	if e != nil {
		return Assignment{}, e
	}
	for groupRows.Next() {
		var g AssignmentGroup
		if e = groupRows.Scan(&g.ID, &g.Name); e != nil {
			groupRows.Close()
			return Assignment{}, e
		}
		a.Groups = append(a.Groups, g)
	}
	groupRows.Close()
	a.RelevantSchedules = []AssignmentSchedule{}
	a.ClockSkewWarningSeconds = 300
	if s.scheduling != nil {
		_, _, a.ClockSkewWarningSeconds, err = s.scheduling.ConfigFor(ctx)
		if err != nil {
			return Assignment{}, err
		}
	}
	scheduleRows, e := s.db.Query(ctx, `SELECT DISTINCT s.id,s.name,COALESCE(p.name,l.name,''),CASE WHEN s.display_action IS NOT NULL THEN 'display_control' WHEN s.layout_id IS NOT NULL THEN 'layout' ELSE 'playlist' END,s.priority,s.enabled FROM schedules s LEFT JOIN playlists p ON p.id=s.playlist_id LEFT JOIN layouts l ON l.id=s.layout_id JOIN schedule_targets t ON t.schedule_id=s.id LEFT JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id AND m.screen_id=$1 WHERE s.deleted_at IS NULL AND (t.screen_id=$1 OR m.screen_id=$1) ORDER BY s.priority DESC,s.id`, screenID)
	if e != nil {
		return Assignment{}, e
	}
	for scheduleRows.Next() {
		var x AssignmentSchedule
		if e = scheduleRows.Scan(&x.ID, &x.Name, &x.PlaylistName, &x.PresentationType, &x.Priority, &x.Enabled); e != nil {
			scheduleRows.Close()
			return Assignment{}, e
		}
		a.RelevantSchedules = append(a.RelevantSchedules, x)
	}
	scheduleRows.Close()
	a.SynchronizationStatus = "not_reported"
	if a.PlayerActiveManifestVersion != nil {
		if *a.PlayerActiveManifestVersion == a.ManifestVersion {
			a.SynchronizationStatus = "current"
		} else if a.PlayerPendingManifestVersion != nil && *a.PlayerPendingManifestVersion == a.ManifestVersion {
			a.SynchronizationStatus = "preparing"
		} else {
			a.SynchronizationStatus = "out_of_date"
		}
	}
	return a, nil
}

func (s *Service) projectSpanVideo(ctx context.Context, screenID, assetID, sourceVariantID uuid.UUID, asset *ManifestAsset, enabled bool) (uuid.UUID, error) {
	if !enabled || s.span == nil {
		return sourceVariantID, nil
	}
	panel, err := s.span.PrepareVideo(ctx, screenID, assetID, sourceVariantID)
	if errors.Is(err, span.ErrNotFound) {
		return sourceVariantID, nil
	}
	if err != nil {
		return uuid.Nil, err
	}
	if panel.Status != "ready" {
		if panel.Status == "failed" {
			return uuid.Nil, fmt.Errorf("%w: Span video preparation failed", ErrConflict)
		}
		return uuid.Nil, fmt.Errorf("%w: Span video panel is still preparing", ErrConflict)
	}
	asset.VariantID = panel.ID
	asset.MIMEType = panel.MIMEType
	asset.FileSize = panel.FileSize
	asset.SHA256 = panel.SHA256
	asset.DownloadPath = panel.DownloadPath
	width, height := panel.Width, panel.Height
	duration := panel.DurationSeconds
	asset.Width, asset.Height, asset.DurationSeconds = &width, &height, &duration
	return panel.ID, nil
}

func (s *Service) BuildManifest(ctx context.Context, screenID uuid.UUID) (Manifest, string, error) {
	if err := s.reconcilePresentationCatalog(ctx); err != nil {
		return Manifest{}, "", err
	}
	if s.presentationOverrides != nil {
		if err := s.presentationOverrides.ReconcileExpired(ctx); err != nil {
			return Manifest{}, "", err
		}
	}
	now := time.Now().UTC()
	// Expiration is persisted during reconciliation so an unchanged ETag can never
	// hide the removal of a takeover from a player. The takeover state transition
	// and manifest version bump share one transaction; a failed bump cannot leave
	// an expired takeover with an old conditional-response identity.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Manifest{}, "", err
	}
	defer tx.Rollback(ctx)
	var expired bool
	if err = tx.QueryRow(ctx, `WITH changed AS (
		UPDATE takeovers e SET status='expired',updated_at=now()
		WHERE e.status='active' AND e.expires_at<=now() AND EXISTS(SELECT 1 FROM takeover_screen_states es WHERE es.takeover_id=e.id AND es.screen_id=$1)
		RETURNING e.id),
		updated AS (
		UPDATE takeover_screen_states es SET state='expired',restored_at=now(),last_updated_at=now()
		WHERE es.screen_id=$1 AND es.takeover_id IN(SELECT id FROM changed) RETURNING true)
		SELECT EXISTS(SELECT 1 FROM changed) OR EXISTS(SELECT 1 FROM updated)`, screenID).Scan(&expired); err != nil {
		return Manifest{}, "", err
	}
	expirationNotes := []notification{}
	if expired {
		expirationNotes, err = bumpScreensInTx(ctx, tx, []uuid.UUID{screenID}, "takeover.expired")
		if err != nil {
			return Manifest{}, "", err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Manifest{}, "", err
	}
	s.notify(expirationNotes)
	assignment, err := s.Assignment(ctx, screenID)
	if err != nil {
		return Manifest{}, "", err
	}
	var changed time.Time
	if err = s.db.QueryRow(ctx, `UPDATE screen_manifest_state SET last_requested_at=now() WHERE screen_id=$1 RETURNING changed_at`, screenID).Scan(&changed); err != nil {
		return Manifest{}, "", err
	}
	prefetch, grace := 14, 30
	if s.scheduling != nil {
		prefetch, grace, _, err = s.scheduling.ConfigFor(ctx)
		if err != nil {
			return Manifest{}, "", err
		}
	}
	manifest := Manifest{SchemaVersion: 11, ManifestVersion: assignment.ManifestVersion, ScreenID: screenID, GeneratedAt: changed, ServerTime: now, Mode: "presentation", Assets: []ManifestAsset{}, Playlists: []ManifestPlaylist{}, Layouts: []ManifestLayout{}, Schedules: []ManifestSchedule{}, Websites: []ManifestWebsite{}, Widgets: []ManifestWidget{}, DataSources: []ManifestDataSource{}, Plugins: []plugins.ManifestPlugin{}, PrefetchHorizonDays: prefetch, ActivationGraceSeconds: grace}
	// Branding is part of the player fallback, not a dashboard-only concern.
	// Project its exact image variant into the same verified asset set so a
	// paired player can render the no-content screen while offline. A stale or
	// deleted logo is intentionally omitted; the configured colors/text remain
	// valid and the fallback stays usable.
	var brandingAssetID *uuid.UUID
	if queryErr := s.db.QueryRow(ctx, `SELECT NULLIF(o.settings->>'branding.logo_asset_id','')::uuid FROM organization_runtime_settings o JOIN screens sc ON sc.organization_id=o.organization_id WHERE sc.id=$1`, screenID).Scan(&brandingAssetID); queryErr != nil && !errors.Is(queryErr, pgx.ErrNoRows) {
		return Manifest{}, "", queryErr
	}
	if brandingAssetID != nil {
		brandingAsset, resolveErr := s.resolveImageVariant(ctx, *brandingAssetID)
		if resolveErr == nil && windowAvailable(brandingAsset.AvailableFrom, brandingAsset.ExpiresAt, now) {
			brandingVariantID := brandingAsset.VariantID
			manifest.Branding = &ManifestBranding{LogoAssetID: brandingAssetID, LogoVariantID: &brandingVariantID}
			manifest.Assets = append(manifest.Assets, brandingAsset)
		} else if resolveErr != nil && !errors.Is(resolveErr, pgx.ErrNoRows) {
			return Manifest{}, "", resolveErr
		}
	}
	spanEnabled := false
	if s.span != nil {
		panel, canvas, spanErr := s.span.ViewportForScreen(ctx, screenID)
		if errors.Is(spanErr, span.ErrNotReady) {
			return Manifest{}, "", fmt.Errorf("%w: Span geometry is incomplete", ErrConflict)
		}
		if spanErr != nil {
			return Manifest{}, "", spanErr
		}
		if panel != nil && canvas != nil {
			spanEnabled = true
			manifest.SchemaVersion = 15
			manifest.Canvas = &ManifestCanvas{Width: canvas.Width, Height: canvas.Height}
			manifest.Viewport = &ManifestViewport{X: panel.X, Y: panel.Y, Width: panel.Width, Height: panel.Height, Rotation: panel.Rotation, Order: panel.PanelOrder, BezelLeft: panel.BezelLeft, BezelTop: panel.BezelTop, BezelRight: panel.BezelRight, BezelBottom: panel.BezelBottom}
		}
	}
	if s.plugins != nil {
		manifest.Plugins, err = s.plugins.ManifestForScreen(ctx, screenID)
		if err != nil {
			return Manifest{}, "", err
		}
	}
	var syncGroup ManifestSyncGroup
	if groupErr := s.db.QueryRow(ctx, `SELECT g.id,g.playback_epoch FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id WHERE m.screen_id=$1 AND g.deleted_at IS NULL`, screenID).Scan(&syncGroup.ID, &syncGroup.PlaybackEpoch); groupErr == nil {
		manifest.SyncGroup = &syncGroup
	} else if !errors.Is(groupErr, pgx.ErrNoRows) {
		return Manifest{}, "", groupErr
	}
	playlistIDs := []uuid.UUID{}
	layoutIDs := []uuid.UUID{}
	var presentationOverride *PresentationOverride
	if s.presentationOverrides != nil {
		presentationOverride, err = s.presentationOverrides.ActiveForScreen(ctx, screenID)
		if err != nil {
			return Manifest{}, "", err
		}
		if presentationOverride != nil {
			manifest.PresentationOverride = &ManifestPresentationOverride{
				ID:          presentationOverride.ID,
				ContentType: presentationOverride.ContentType,
				ContentID:   presentationOverride.ContentID,
				ContentName: presentationOverride.ContentName,
				StartedAt:   presentationOverride.StartedAt,
				ExpiresAt:   presentationOverride.ExpiresAt,
				WakeDisplay: presentationOverride.WakeDisplay,
			}
			switch presentationOverride.ContentType {
			case "playlist":
				playlistIDs = append(playlistIDs, presentationOverride.ContentID)
			case "layout":
				layoutIDs = append(layoutIDs, presentationOverride.ContentID)
			}
		}
	}
	if assignment.PlaylistID != nil {
		playlistIDs = append(playlistIDs, *assignment.PlaylistID)
	}
	if assignment.LayoutID != nil {
		layoutIDs = append(layoutIDs, *assignment.LayoutID)
	}
	var takeover ManifestTakeover
	if takeoverErr := s.db.QueryRow(ctx, `SELECT e.id,e.playlist_id,e.activated_at,e.expires_at FROM takeovers e JOIN takeover_screen_states es ON es.takeover_id=e.id WHERE es.screen_id=$1 AND e.status='active' AND e.expires_at>now() AND es.state NOT IN ('restored','cancelled','expired') ORDER BY e.activated_at DESC,e.id DESC LIMIT 1`, screenID).Scan(&takeover.ID, &takeover.PlaylistID, &takeover.ActivatedAt, &takeover.ExpiresAt); takeoverErr == nil {
		manifest.Takeover = &takeover
		manifest.LegacyTakeover = &takeover
		playlistIDs = append([]uuid.UUID{takeover.PlaylistID}, playlistIDs...)
	} else if !errors.Is(takeoverErr, pgx.ErrNoRows) {
		return Manifest{}, "", takeoverErr
	}
	if s.scheduling != nil {
		records, loadErr := s.scheduling.Relevant(ctx, screenID)
		if loadErr != nil {
			return Manifest{}, "", loadErr
		}
		horizon := now.AddDate(0, 0, prefetch)
		for _, record := range records {
			if record.Type == scheduling.OneTime {
				if record.OneTimeEnd != nil && !record.OneTimeEnd.After(now) {
					continue
				}
				if record.OneTimeStart != nil && record.OneTimeStart.After(horizon) {
					continue
				}
			}
			var schedulePlaylistID *uuid.UUID
			if record.LayoutID == nil && record.DisplayAction == nil && record.PlaylistID != uuid.Nil {
				value := record.PlaylistID
				schedulePlaylistID = &value
			}
			manifest.Schedules = append(manifest.Schedules, ManifestSchedule{ID: record.ID, PlaylistID: schedulePlaylistID, LayoutID: record.LayoutID, DisplayAction: record.DisplayAction, Type: string(record.Type), Timezone: record.Timezone, Priority: record.Priority, Specificity: record.Specificity, StartDate: record.StartDate, EndDate: record.EndDate, OneTimeStart: record.OneTimeStart, OneTimeEnd: record.OneTimeEnd, DailyStart: record.DailyStart, DailyEnd: record.DailyEnd, DaysOfWeek: record.DaysOfWeek})
			if record.LayoutID != nil {
				layoutIDs = append(layoutIDs, *record.LayoutID)
			} else if record.DisplayAction == nil && record.PlaylistID != uuid.Nil {
				playlistIDs = append(playlistIDs, record.PlaylistID)
			}
		}
	}
	// Validate every active and scheduled root through the same graph walk used
	// by assignment and Quick Present. This is deliberately before projection:
	// a deleted or unpublished Layout must not be allowed to disappear merely
	// because its playlist item has no asset_id.
	if len(playlistIDs) > 0 || len(layoutIDs) > 0 || (presentationOverride != nil && presentationOverride.ContentType == "asset") {
		readinessTx, readinessErr := s.db.Begin(ctx)
		if readinessErr != nil {
			return Manifest{}, "", readinessErr
		}
		for _, id := range uniqueUUIDs(playlistIDs) {
			if readinessErr = s.ValidatePresentationInTx(ctx, readinessTx, "playlist", id, now); readinessErr != nil {
				readinessTx.Rollback(ctx)
				return Manifest{}, "", readinessErr
			}
		}
		for _, id := range uniqueUUIDs(layoutIDs) {
			if readinessErr = s.ValidatePresentationInTx(ctx, readinessTx, "layout", id, now); readinessErr != nil {
				readinessTx.Rollback(ctx)
				return Manifest{}, "", readinessErr
			}
		}
		if presentationOverride != nil && presentationOverride.ContentType == "asset" {
			if readinessErr = s.ValidatePresentationInTx(ctx, readinessTx, "asset", presentationOverride.ContentID, now); readinessErr != nil {
				readinessTx.Rollback(ctx)
				return Manifest{}, "", readinessErr
			}
		}
		if readinessErr = readinessTx.Commit(ctx); readinessErr != nil {
			return Manifest{}, "", readinessErr
		}
	}
	// Expand the complete presentation graph before projecting it. Playlists may contain
	// published Layouts, and Layouts may contain playlist zones; UNION makes cycles finite.
	graphRows, graphErr := s.db.Query(ctx, `
		WITH RECURSIVE refs(kind,id) AS (
			SELECT 'playlist', unnest($1::uuid[])
			UNION
			SELECT 'layout', unnest($2::uuid[])
			UNION
			SELECT next.kind,next.id
			FROM refs ref
			CROSS JOIN LATERAL (
				SELECT 'layout'::text AS kind,item.layout_id AS id
				FROM playlist_items item
				WHERE ref.kind='playlist' AND item.playlist_id=ref.id AND item.layout_id IS NOT NULL
				UNION
				SELECT 'playlist'::text,dependency.dependency_id
				FROM layouts layout
				JOIN layout_revision_dependencies dependency
				  ON dependency.revision_id=layout.published_revision_id
				 AND dependency.dependency_type='playlist'
				WHERE ref.kind='layout' AND layout.id=ref.id AND layout.deleted_at IS NULL
			) next
		)
		SELECT kind,id FROM refs`, uniqueUUIDs(playlistIDs), uniqueUUIDs(layoutIDs))
	if graphErr != nil {
		return Manifest{}, "", graphErr
	}
	for graphRows.Next() {
		var kind string
		var id uuid.UUID
		if graphErr = graphRows.Scan(&kind, &id); graphErr != nil {
			graphRows.Close()
			return Manifest{}, "", graphErr
		}
		if kind == "layout" {
			layoutIDs = append(layoutIDs, id)
		} else {
			playlistIDs = append(playlistIDs, id)
		}
	}
	graphRows.Close()
	if graphErr = graphRows.Err(); graphErr != nil {
		return Manifest{}, "", graphErr
	}
	type layoutManifestDependency struct {
		Type string
		ID   uuid.UUID
	}
	layoutDependencies := []layoutManifestDependency{}
	layoutAssetVariants := map[uuid.UUID][]*uuid.UUID{}
	for _, layoutID := range uniqueUUIDs(layoutIDs) {
		item := ManifestLayout{ID: layoutID}
		var raw []byte
		if err = s.db.QueryRow(ctx, `SELECT r.id,r.revision,r.document_sha256,r.document FROM layouts l JOIN layout_revisions r ON r.id=l.published_revision_id WHERE l.id=$1 AND l.deleted_at IS NULL`, layoutID).Scan(&item.RevisionID, &item.Revision, &item.DocumentSHA256, &raw); err != nil {
			return Manifest{}, "", fmt.Errorf("%w: published Layout unavailable", ErrConflict)
		}
		if err = json.Unmarshal(raw, &item.Document); err != nil {
			return Manifest{}, "", err
		}
		if assetID := item.Document.Canvas.BackgroundAssetID; assetID != nil {
			resolved, resolveErr := s.resolveAssetVariant(ctx, *assetID, item.Document.Canvas.BackgroundVariantID)
			if resolveErr != nil {
				return Manifest{}, "", fmt.Errorf("%w: Layout background variant unavailable", ErrConflict)
			}
			if item.Document.Canvas.BackgroundVariantID == nil {
				variantID := resolved.VariantID
				item.Document.Canvas.BackgroundVariantID = &variantID
			}
			layoutAssetVariants[*assetID] = append(layoutAssetVariants[*assetID], item.Document.Canvas.BackgroundVariantID)
		}
		for index := range item.Document.Placements {
			placement := &item.Document.Placements[index]
			if placement.Type == "asset" && placement.AssetID != nil {
				resolved, resolveErr := s.resolveAssetVariant(ctx, *placement.AssetID, placement.VariantID)
				if resolveErr != nil {
					return Manifest{}, "", fmt.Errorf("%w: Layout asset variant unavailable", ErrConflict)
				}
				if placement.VariantID == nil {
					variantID := resolved.VariantID
					placement.VariantID = &variantID
				}
				layoutAssetVariants[*placement.AssetID] = append(layoutAssetVariants[*placement.AssetID], placement.VariantID)
			}
		}
		rows, queryErr := s.db.Query(ctx, `SELECT dependency_type,dependency_id FROM layout_revision_dependencies WHERE revision_id=$1`, item.RevisionID)
		if queryErr != nil {
			return Manifest{}, "", queryErr
		}
		for rows.Next() {
			var dependency layoutManifestDependency
			if queryErr = rows.Scan(&dependency.Type, &dependency.ID); queryErr != nil {
				rows.Close()
				return Manifest{}, "", queryErr
			}
			layoutDependencies = append(layoutDependencies, dependency)
			if dependency.Type == "playlist" {
				playlistIDs = append(playlistIDs, dependency.ID)
			}
		}
		rows.Close()
		manifest.Layouts = append(manifest.Layouts, item)
		if assignment.LayoutID != nil && layoutID == *assignment.LayoutID {
			fallback := item
			manifest.DirectFallbackLayout = &fallback
			manifest.Layout = &fallback
		}
	}
	seen := map[uuid.UUID]bool{}
	seenPlaylists := map[uuid.UUID]bool{}
	if presentationOverride != nil && presentationOverride.ContentType == "asset" {
		virtual, projectionErr := s.projectPresentationAsset(ctx, screenID, &manifest, *presentationOverride, seen, spanEnabled)
		if projectionErr != nil {
			return Manifest{}, "", projectionErr
		}
		manifest.Playlists = append(manifest.Playlists, virtual)
		manifest.PresentationOverride.PlaylistID = &virtual.ID
		manifest.Playlist = &virtual
	}
	for _, playlistID := range playlistIDs {
		if seenPlaylists[playlistID] {
			continue
		}
		seenPlaylists[playlistID] = true
		playlist, loadErr := s.Get(ctx, playlistID)
		if loadErr != nil {
			return Manifest{}, "", loadErr
		}
		mp := ManifestPlaylist{ID: playlist.ID, Revision: playlist.Revision, Name: playlist.Name, Items: []ManifestItem{}}
		for _, item := range playlist.Items {
			if item.AssetStatus != "ready" || (item.AssetType != "widget" && item.AssetType != "layout" && item.VariantID == nil) {
				return Manifest{}, "", fmt.Errorf("%w: playlist contains an unavailable asset", ErrConflict)
			}
			if item.AssetType == "layout" {
				if item.LayoutID == nil {
					return Manifest{}, "", fmt.Errorf("%w: playlist Layout is unavailable", ErrConflict)
				}
				mp.Items = append(mp.Items, ManifestItem{ID: item.ID, AssetID: *item.LayoutID, LayoutID: item.LayoutID, AssetType: "layout", DurationMS: item.DurationMS, FitMode: item.FitMode, Transition: item.Transition, AudioEnabled: false, Volume: 0, DeliveryPolicy: "stream"})
				continue
			}
			if item.AssetID == uuid.Nil {
				return Manifest{}, "", fmt.Errorf("%w: playlist asset is unavailable", ErrConflict)
			}
			if item.AssetType == "widget" {
				var widget ManifestWidget
				widget.AssetID = item.AssetID
				widget.Name = item.AssetName
				if err = s.db.QueryRow(ctx, `SELECT provider,preset_id,config_version,configuration FROM widgets WHERE asset_id=$1`, item.AssetID).Scan(&widget.Provider, &widget.PresetID, &widget.ConfigVersion, &widget.Configuration); err != nil {
					return Manifest{}, "", err
				}
				var configuration map[string]any
				if err = json.Unmarshal(widget.Configuration, &configuration); err != nil {
					return Manifest{}, "", err
				}
				if rawFallback, ok := configuration["fallbackImageAssetId"].(string); ok && rawFallback != "" {
					fallbackID, parseErr := uuid.Parse(rawFallback)
					if parseErr != nil {
						return Manifest{}, "", fmt.Errorf("%w: widget fallback image is invalid", ErrConflict)
					}
					fallback, resolveErr := s.resolveImageVariant(ctx, fallbackID)
					if resolveErr != nil {
						return Manifest{}, "", fmt.Errorf("%w: widget fallback image unavailable", ErrConflict)
					}
					configuration["fallbackVariantId"] = fallback.VariantID.String()
					if !seen[fallback.VariantID] {
						manifest.Assets = append(manifest.Assets, fallback)
						seen[fallback.VariantID] = true
					}
				}
				widget.Configuration, _ = json.Marshal(configuration)
				foundWidget := false
				for _, existing := range manifest.Widgets {
					if existing.AssetID == widget.AssetID {
						foundWidget = true
					}
				}
				if !foundWidget {
					manifest.Widgets = append(manifest.Widgets, widget)
				}
				mp.Items = append(mp.Items, ManifestItem{ID: item.ID, AssetID: item.AssetID, AssetType: "widget", DurationMS: item.DurationMS, FitMode: item.FitMode, Transition: item.Transition, AudioEnabled: item.AudioEnabled, Volume: item.Volume, DeliveryPolicy: "stream", AvailableFrom: item.AvailableFrom, ExpiresAt: item.ExpiresAt})
				continue
			}
			if item.AssetType == "website" {
				var website ManifestWebsite
				website.AssetID = item.AssetID
				website.Name = item.AssetName
				err = s.db.QueryRow(ctx, `SELECT url,allowed_hosts,javascript_enabled,dom_storage_enabled,cookie_policy,reload_policy,refresh_interval_seconds,load_timeout_seconds,zoom_percent,scroll_x,scroll_y,custom_user_agent,background_color,failure_behavior,fallback_image_asset_id FROM website_assets WHERE asset_id=$1`, item.AssetID).Scan(&website.URL, &website.AllowedHosts, &website.JavaScriptEnabled, &website.DOMStorageEnabled, &website.CookiePolicy, &website.ReloadPolicy, &website.RefreshIntervalSeconds, &website.LoadTimeoutSeconds, &website.ZoomPercent, &website.ScrollX, &website.ScrollY, &website.CustomUserAgent, &website.BackgroundColor, &website.FailureBehavior, &website.FallbackImageAssetID)
				if err != nil {
					return Manifest{}, "", err
				}
				if website.FallbackImageAssetID != nil {
					fallback, resolveErr := s.resolveImageVariant(ctx, *website.FallbackImageAssetID)
					if resolveErr != nil {
						return Manifest{}, "", fmt.Errorf("%w: website fallback image unavailable", ErrConflict)
					}
					website.FallbackVariantID = &fallback.VariantID
					if !seen[fallback.VariantID] {
						manifest.Assets = append(manifest.Assets, fallback)
						seen[fallback.VariantID] = true
					}
				}
				found := false
				for _, existing := range manifest.Websites {
					if existing.AssetID == website.AssetID {
						found = true
					}
				}
				if !found {
					manifest.Websites = append(manifest.Websites, website)
				}
				mp.Items = append(mp.Items, ManifestItem{ID: item.ID, AssetID: item.AssetID, AssetType: "website", DurationMS: item.DurationMS, FitMode: item.FitMode, Transition: item.Transition, AudioEnabled: false, Volume: 0, DeliveryPolicy: "stream", AvailableFrom: item.AvailableFrom, ExpiresAt: item.ExpiresAt})
				continue
			}
			var asset ManifestAsset
			err = s.db.QueryRow(ctx, `SELECT v.asset_id,v.id,v.mime_type,encode(v.sha256,'hex'),v.file_size,v.width,v.height,v.duration_seconds,a.available_from,a.expires_at FROM asset_variants v JOIN assets a ON a.id=v.asset_id AND a.deleted_at IS NULL WHERE v.id=$1 AND v.deleted_at IS NULL AND v.player_compatible=TRUE`, *item.VariantID).Scan(&asset.AssetID, &asset.VariantID, &asset.MIMEType, &asset.SHA256, &asset.FileSize, &asset.Width, &asset.Height, &asset.DurationSeconds, &asset.AvailableFrom, &asset.ExpiresAt)
			if err != nil {
				return Manifest{}, "", err
			}
			sourceVariantID := asset.VariantID
			assetVariantID, projectionErr := s.projectSpanVideo(ctx, screenID, item.AssetID, sourceVariantID, &asset, spanEnabled && item.AssetType == "video")
			if projectionErr != nil {
				return Manifest{}, "", projectionErr
			}
			if !spanEnabled || item.AssetType != "video" {
				asset.DownloadPath = "/api/v1/player/assets/" + asset.AssetID.String() + "/variants/" + asset.VariantID.String()
			}
			mp.Items = append(mp.Items, ManifestItem{ID: item.ID, AssetID: item.AssetID, AssetType: item.AssetType, VariantID: &assetVariantID, DurationMS: item.DurationMS, FitMode: item.FitMode, Transition: item.Transition, AudioEnabled: item.AudioEnabled, Volume: item.Volume, VideoStartOffsetMS: item.VideoStartOffsetMS, VideoEndOffsetMS: item.VideoEndOffsetMS, DeliveryPolicy: item.DeliveryPolicy, UsePlayerDefaults: item.UsePlayerDefaults, AvailableFrom: item.AvailableFrom, ExpiresAt: item.ExpiresAt})
			if !seen[asset.VariantID] {
				manifest.Assets = append(manifest.Assets, asset)
				seen[asset.VariantID] = true
			}
		}
		manifest.Playlists = append(manifest.Playlists, mp)
		if assignment.PlaylistID != nil && playlistID == *assignment.PlaylistID {
			fallback := mp
			manifest.DirectFallbackPlaylist = &fallback
		}
	}
	if presentationOverride != nil {
		switch presentationOverride.ContentType {
		case "playlist":
			for index := range manifest.Playlists {
				if manifest.Playlists[index].ID == presentationOverride.ContentID {
					selected := manifest.Playlists[index]
					manifest.PresentationOverride.PlaylistID = &selected.ID
					manifest.Playlist = &selected
					break
				}
			}
		case "layout":
			for index := range manifest.Layouts {
				if manifest.Layouts[index].ID == presentationOverride.ContentID {
					selected := manifest.Layouts[index]
					manifest.PresentationOverride.LayoutID = &selected.ID
					manifest.Layout = &selected
					break
				}
			}
		}
	}
	for _, dependency := range layoutDependencies {
		switch dependency.Type {
		case "asset":
			refs := layoutAssetVariants[dependency.ID]
			if len(refs) == 0 {
				refs = []*uuid.UUID{nil}
			}
			for _, requestedVariantID := range refs {
				asset, resolveErr := s.resolveAssetVariant(ctx, dependency.ID, requestedVariantID)
				if resolveErr != nil {
					return Manifest{}, "", fmt.Errorf("%w: Layout Asset unavailable", ErrConflict)
				}
				sourceVariantID := asset.VariantID
				_, projectionErr := s.projectSpanVideo(ctx, screenID, dependency.ID, sourceVariantID, &asset, spanEnabled && strings.HasPrefix(asset.MIMEType, "video/"))
				if projectionErr != nil {
					return Manifest{}, "", projectionErr
				}
				if !spanEnabled || !strings.HasPrefix(asset.MIMEType, "video/") {
					asset.DownloadPath = "/api/v1/player/assets/" + asset.AssetID.String() + "/variants/" + asset.VariantID.String()
				}
				if !seen[asset.VariantID] {
					manifest.Assets = append(manifest.Assets, asset)
					seen[asset.VariantID] = true
				}
			}
		case "widget":
			found := false
			for _, widget := range manifest.Widgets {
				if widget.AssetID == dependency.ID {
					found = true
					break
				}
			}
			if found {
				continue
			}
			var widget ManifestWidget
			widget.AssetID = dependency.ID
			if err = s.db.QueryRow(ctx, `SELECT a.name,w.provider,w.preset_id,w.config_version,w.configuration FROM widgets w JOIN assets a ON a.id=w.asset_id AND a.deleted_at IS NULL WHERE w.asset_id=$1`, dependency.ID).Scan(&widget.Name, &widget.Provider, &widget.PresetID, &widget.ConfigVersion, &widget.Configuration); err != nil {
				return Manifest{}, "", fmt.Errorf("%w: Layout Widget unavailable", ErrConflict)
			}
			if widget.Provider == "website" {
				// Website widgets use the authoritative website_assets row, just like
				// playlist items and Quick Present. Do not deserialize an old widget
				// configuration here: that path omitted fallback variants and could
				// render an archived or unavailable fallback through a layout.
				if err = s.projectPresentationWebsite(ctx, &manifest, widget.AssetID, widget.Name); err != nil {
					return Manifest{}, "", fmt.Errorf("%w: Layout website unavailable", ErrConflict)
				}
			}
			manifest.Widgets = append(manifest.Widgets, widget)
		case "data_source":
			if err = s.projectDataSource(ctx, &manifest, dependency.ID); err != nil {
				return Manifest{}, "", err
			}
		}
	}
	for index := range manifest.Widgets {
		if err = s.projectWidgetAssets(ctx, &manifest, &manifest.Widgets[index], seen); err != nil {
			return Manifest{}, "", err
		}
	}
	if err = s.projectPluginAssets(ctx, &manifest, seen); err != nil {
		return Manifest{}, "", err
	}
	// Project the shared dataset for every Data Source every data-driven widget in
	// the manifest references. Release-defined widgets may reference more than one.
	for _, widget := range append([]ManifestWidget(nil), manifest.Widgets...) {
		for _, id := range s.widgetDataSourceIDs(widget.Provider, widget.Configuration) {
			if err = s.projectDataSource(ctx, &manifest, id); err != nil {
				return Manifest{}, "", err
			}
		}
	}
	requiresV12 := false
	for _, widget := range manifest.Widgets {
		if widget.ConfigVersion >= 2 || widget.Provider == "countdown" || widget.Provider == "metric" || widget.Provider == "cards" || widget.Provider == "weather" {
			requiresV12 = true
			break
		}
	}
	if !requiresV12 {
		for _, source := range manifest.DataSources {
			if source.Provider == "manual" || source.Provider == "weather" {
				requiresV12 = true
				break
			}
		}
	}
	if requiresV12 {
		ids := make([]uuid.UUID, 0, len(manifest.DataSources))
		for _, source := range manifest.DataSources {
			ids = append(ids, source.ID)
		}
		manifest.SchemaVersion = 12
		manifest.DataSources = []ManifestDataSource{}
		for _, id := range ids {
			if err = s.projectDataSource(ctx, &manifest, id); err != nil {
				return Manifest{}, "", err
			}
		}
	}
	requiresV13 := false
	v13Blocker := ""
	for _, widget := range manifest.Widgets {
		if s.widgetRequiresV13(widget.Provider) {
			requiresV13 = true
			if v13Blocker == "" {
				v13Blocker = "Widget “" + widget.Name + "”"
			}
		}
	}
	for _, source := range manifest.DataSources {
		if s.sourceRequiresV13(source.Provider) {
			requiresV13 = true
			if v13Blocker == "" {
				v13Blocker = "Data Source “" + source.Name + "”"
			}
		}
	}
	compiled := make([]*WidgetPresentation, len(manifest.Widgets))
	canCompileV13 := true
	for index := range manifest.Widgets {
		compiled[index], _ = s.compileWidgetPresentationForPreset(manifest.Widgets[index].Provider, manifest.Widgets[index].PresetID, manifest.Widgets[index].Configuration)
		if compiled[index] == nil {
			canCompileV13 = false
			break
		}
	}
	playerCapabilities, capabilityErr := readPlayerPresentationCapabilities(ctx, s.db, screenID)
	if capabilityErr != nil {
		return Manifest{}, "", capabilityErr
	}
	useV13 := false
	if playerCapabilities.Reported && canCompileV13 {
		for index, presentation := range compiled {
			if err = checkPresentationCompatibility(ctx, s.db, screenID, manifest.Widgets[index].Name, presentation, playerCapabilities); err != nil {
				return Manifest{}, "", fmt.Errorf("%w: %v", ErrConflict, err)
			}
		}
		useV13 = true
	} else if requiresV13 {
		return Manifest{}, "", fmt.Errorf("%w: %v", ErrConflict, sourceCapabilityError(screenDisplayName(ctx, s.db, screenID), v13Blocker))
	}
	if useV13 {
		ids := make([]uuid.UUID, 0, len(manifest.DataSources))
		for _, source := range manifest.DataSources {
			ids = append(ids, source.ID)
		}
		manifest.SchemaVersion = 13
		manifest.DataSources = []ManifestDataSource{}
		for _, id := range ids {
			if err = s.projectDataSource(ctx, &manifest, id); err != nil {
				return Manifest{}, "", err
			}
		}
		for index := range manifest.DataSources {
			document, projectionErr := projectDataDocument(manifest.DataSources[index].Configuration)
			if projectionErr != nil {
				return Manifest{}, "", fmt.Errorf("%w: Data Source cannot be projected to v13: %v", ErrConflict, projectionErr)
			}
			manifest.DataSources[index].DataDocument = document
			manifest.DataSources[index].Configuration = nil
		}
		for index := range manifest.Widgets {
			manifest.Widgets[index].Presentation = compiled[index]
			manifest.Widgets[index].Configuration = nil
		}
	}
	if spanEnabled || manifestHasWebReload(manifest) {
		manifest.SchemaVersion = 15
	} else if manifestHasCrossfade(manifest) {
		if useV13 && playerCapabilities.PlayerVersion >= crossfadePlayerVersionCode {
			manifest.SchemaVersion = 14
		} else {
			downgradeManifestCrossfades(&manifest)
		}
	}
	encoded, encodeErr := json.Marshal(manifest)
	if encodeErr != nil {
		return Manifest{}, "", encodeErr
	}
	if len(encoded) > 5*1024*1024 {
		return Manifest{}, "", fmt.Errorf("%w: manifest exceeds the five MiB limit", ErrConflict)
	}
	baseETag := manifestETagForSchema(screenID, assignment.ManifestVersion, manifest.SchemaVersion)
	baseETag = manifestETagForSchedules(baseETag, manifest.Schedules)
	// The version is an efficient push/change signal, but the response body is
	// the authoritative dependency snapshot. Hash a stable copy as well so a
	// missed invalidation cannot make a conditional request incorrectly return
	// 304. GeneratedAt and ServerTime are intentionally excluded because they
	// change on every read.
	stable := manifest
	stable.GeneratedAt = time.Time{}
	stable.ServerTime = time.Time{}
	stableEncoded, err := json.Marshal(stable)
	if err != nil {
		return Manifest{}, "", err
	}
	value := sha256.Sum256(append([]byte(baseETag+":"), stableEncoded...))
	return manifest, `"sha256-` + hex.EncodeToString(value[:]) + `"`, nil
}

func manifestHasWebReload(manifest Manifest) bool {
	for _, widget := range manifest.Widgets {
		if widget.Presentation != nil && widget.Presentation.Web != nil && widget.Presentation.Web.Reload != nil {
			return true
		}
	}
	return false
}

// projectPresentationAsset adapts one library asset into the same one-item
// playlist shape used by the normal Player renderer. This keeps Quick Present
// lightweight without creating hidden playlists that would leak into the
// content library or require cleanup after expiry.
func (s *Service) projectPresentationAsset(ctx context.Context, screenID uuid.UUID, manifest *Manifest, override PresentationOverride, seen map[uuid.UUID]bool, spanEnabled bool) (ManifestPlaylist, error) {
	var name, assetType, status string
	var availableFrom, expiresAt *time.Time
	if err := s.db.QueryRow(ctx, `SELECT name,type,processing_status,available_from,expires_at FROM assets WHERE id=$1 AND deleted_at IS NULL AND archived_at IS NULL AND origin='library' AND system_managed=FALSE`, override.ContentID).Scan(&name, &assetType, &status, &availableFrom, &expiresAt); err != nil {
		return ManifestPlaylist{}, fmt.Errorf("%w: Quick Present content is unavailable", ErrConflict)
	}
	if status != "ready" {
		return ManifestPlaylist{}, fmt.Errorf("%w: Quick Present content is still processing", ErrConflict)
	}
	itemID := uuid.NewSHA1(override.ID, []byte("quick-present-item"))
	item := ManifestItem{ID: itemID, AssetID: override.ContentID, AssetType: assetType, FitMode: "contain", Transition: "none", AudioEnabled: false, Volume: 1, DeliveryPolicy: "download", AvailableFrom: availableFrom, ExpiresAt: expiresAt}
	switch assetType {
	case "image", "video":
		var asset ManifestAsset
		if err := s.db.QueryRow(ctx, `SELECT v.asset_id,v.id,v.mime_type,encode(v.sha256,'hex'),v.file_size,v.width,v.height,v.duration_seconds,a.available_from,a.expires_at FROM asset_variants v JOIN assets a ON a.id=v.asset_id AND a.deleted_at IS NULL WHERE v.asset_id=$1 AND v.deleted_at IS NULL AND v.player_compatible=TRUE ORDER BY CASE v.kind WHEN 'playback' THEN 0 WHEN 'original' THEN 1 ELSE 2 END,v.id LIMIT 1`, override.ContentID).Scan(&asset.AssetID, &asset.VariantID, &asset.MIMEType, &asset.SHA256, &asset.FileSize, &asset.Width, &asset.Height, &asset.DurationSeconds, &asset.AvailableFrom, &asset.ExpiresAt); err != nil {
			return ManifestPlaylist{}, fmt.Errorf("%w: Quick Present media variant is unavailable", ErrConflict)
		}
		sourceVariantID := asset.VariantID
		projectedVariantID, projectionErr := s.projectSpanVideo(ctx, screenID, override.ContentID, sourceVariantID, &asset, spanEnabled && assetType == "video")
		if projectionErr != nil {
			return ManifestPlaylist{}, projectionErr
		}
		if !spanEnabled || assetType != "video" {
			asset.DownloadPath = "/api/v1/player/assets/" + asset.AssetID.String() + "/variants/" + asset.VariantID.String()
		}
		if !seen[asset.VariantID] {
			manifest.Assets = append(manifest.Assets, asset)
			seen[asset.VariantID] = true
		}
		item.VariantID = &projectedVariantID
		if assetType == "image" {
			duration := int64(10_000)
			item.DurationMS = &duration
		} else {
			item.AudioEnabled = true
		}
	case "widget":
		var widget ManifestWidget
		widget.AssetID = override.ContentID
		if err := s.db.QueryRow(ctx, `SELECT w.provider,w.preset_id,w.config_version,w.configuration FROM widgets w WHERE w.asset_id=$1`, override.ContentID).Scan(&widget.Provider, &widget.PresetID, &widget.ConfigVersion, &widget.Configuration); err != nil {
			return ManifestPlaylist{}, fmt.Errorf("%w: Quick Present widget is unavailable", ErrConflict)
		}
		widget.Name = name
		if widget.Provider == "website" {
			if err := s.projectPresentationWebsite(ctx, manifest, override.ContentID, name); err != nil {
				return ManifestPlaylist{}, err
			}
			item.AssetType = "website"
			item.DeliveryPolicy = "stream"
		} else {
			manifest.Widgets = append(manifest.Widgets, widget)
			item.DeliveryPolicy = "stream"
		}
		duration := int64(10_000)
		item.DurationMS = &duration
	case "website":
		if err := s.projectPresentationWebsite(ctx, manifest, override.ContentID, name); err != nil {
			return ManifestPlaylist{}, err
		}
		item.AssetType = "website"
		item.DeliveryPolicy = "stream"
		duration := int64(10_000)
		item.DurationMS = &duration
	default:
		return ManifestPlaylist{}, fmt.Errorf("%w: Quick Present content type is unsupported", ErrConflict)
	}
	return ManifestPlaylist{ID: override.ID, Revision: 1, Name: name, Items: []ManifestItem{item}}, nil
}

func (s *Service) projectPresentationWebsite(ctx context.Context, manifest *Manifest, assetID uuid.UUID, name string) error {
	var website ManifestWebsite
	website.AssetID, website.Name = assetID, name
	if err := s.db.QueryRow(ctx, `SELECT url,allowed_hosts,javascript_enabled,dom_storage_enabled,cookie_policy,reload_policy,refresh_interval_seconds,load_timeout_seconds,zoom_percent,scroll_x,scroll_y,custom_user_agent,background_color,failure_behavior,fallback_image_asset_id FROM website_assets WHERE asset_id=$1`, assetID).Scan(&website.URL, &website.AllowedHosts, &website.JavaScriptEnabled, &website.DOMStorageEnabled, &website.CookiePolicy, &website.ReloadPolicy, &website.RefreshIntervalSeconds, &website.LoadTimeoutSeconds, &website.ZoomPercent, &website.ScrollX, &website.ScrollY, &website.CustomUserAgent, &website.BackgroundColor, &website.FailureBehavior, &website.FallbackImageAssetID); err != nil {
		return fmt.Errorf("%w: Quick Present website is unavailable", ErrConflict)
	}
	if website.FallbackImageAssetID != nil {
		fallback, err := s.resolveImageVariant(ctx, *website.FallbackImageAssetID)
		if err != nil {
			return fmt.Errorf("%w: Quick Present website fallback is unavailable", ErrConflict)
		}
		website.FallbackVariantID = &fallback.VariantID
		found := false
		for _, asset := range manifest.Assets {
			if asset.VariantID == fallback.VariantID {
				found = true
				break
			}
		}
		if !found {
			manifest.Assets = append(manifest.Assets, fallback)
		}
	}
	manifest.Websites = append(manifest.Websites, website)
	return nil
}

const crossfadePlayerVersionCode = 33

func manifestHasCrossfade(manifest Manifest) bool {
	for _, playlist := range []*ManifestPlaylist{manifest.Playlist, manifest.DirectFallbackPlaylist} {
		if playlist != nil && playlistHasCrossfade(*playlist) {
			return true
		}
	}
	for _, playlist := range manifest.Playlists {
		if playlistHasCrossfade(playlist) {
			return true
		}
	}
	return false
}

func downgradeManifestCrossfades(manifest *Manifest) {
	for _, playlist := range []*ManifestPlaylist{manifest.Playlist, manifest.DirectFallbackPlaylist} {
		if playlist != nil {
			downgradePlaylistCrossfades(playlist)
		}
	}
	for playlistIndex := range manifest.Playlists {
		downgradePlaylistCrossfades(&manifest.Playlists[playlistIndex])
	}
}

func playlistHasCrossfade(playlist ManifestPlaylist) bool {
	for _, item := range playlist.Items {
		if item.Transition == "crossfade" {
			return true
		}
	}
	return false
}

func downgradePlaylistCrossfades(playlist *ManifestPlaylist) {
	for itemIndex := range playlist.Items {
		if playlist.Items[itemIndex].Transition == "crossfade" {
			playlist.Items[itemIndex].Transition = "fade"
		}
	}
}

func (s *Service) reconcilePresentationCatalog(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `
		WITH changed AS (
			UPDATE presentation_catalog_state
			SET revision=revision+1,compiler_fingerprint=$1,updated_at=now()
			WHERE singleton=true AND compiler_fingerprint<>$1
			RETURNING revision
		)
		UPDATE screen_manifest_state
		SET manifest_version=manifest_version+1,changed_at=now(),change_reason='presentation.catalog_changed'
		WHERE EXISTS(SELECT 1 FROM changed)`, s.definitions.Fingerprint)
	return err
}

// widgetDataSourceIDs returns every Data Source a widget consumes. Release-defined
// widgets may declare more than one data_source configuration field, so every such
// field is inspected; legacy widgets keep their single dataSourceId behavior. The
// injected definition catalog is the single source of truth for release-defined widgets.
func (s *Service) widgetDataSourceIDs(provider string, configuration json.RawMessage) []uuid.UUID {
	if definition, ok := s.definitions.Widget(provider); ok && !definition.LegacyEditor {
		var values map[string]json.RawMessage
		ids := []uuid.UUID{}
		if json.Unmarshal(configuration, &values) == nil {
			// An App recipe's author schema intentionally hides its managed source. The
			// compiled configuration still carries the explicit relationship so normal
			// manifest dependency resolution, invalidation, and usage tracking see it.
			if definition.Recipe != nil {
				var id uuid.UUID
				if json.Unmarshal(values["managedDataSourceId"], &id) == nil && id != uuid.Nil {
					ids = append(ids, id)
				}
			}
			for _, field := range definition.ConfigurationSchema.Fields {
				if field.Control != "data_source" {
					continue
				}
				var id uuid.UUID
				if json.Unmarshal(values[field.Key], &id) == nil && id != uuid.Nil && !containsUUID(ids, id) {
					ids = append(ids, id)
				}
			}
		}
		return ids
	}
	switch provider {
	case "ticker", "menu", "list", "table", "agenda", "metric", "cards", "weather", "spotlight", "stat_grid", "chart", "progress", "timeline":
		var c struct {
			DataSourceID uuid.UUID `json:"dataSourceId"`
		}
		_ = json.Unmarshal(configuration, &c)
		if c.DataSourceID != uuid.Nil {
			return []uuid.UUID{c.DataSourceID}
		}
	}
	return nil
}

func containsUUID(ids []uuid.UUID, wanted uuid.UUID) bool {
	for _, id := range ids {
		if id == wanted {
			return true
		}
	}
	return false
}

func (s *Service) projectWidgetAssets(ctx context.Context, manifest *Manifest, widget *ManifestWidget, seen map[uuid.UUID]bool) error {
	var configuration map[string]any
	if json.Unmarshal(widget.Configuration, &configuration) != nil {
		return errors.New("widget configuration is invalid")
	}
	for _, reference := range []struct {
		assetKey   string
		variantKey string
		label      string
	}{
		{assetKey: "imageAssetId", variantKey: "imageVariantId", label: "widget image"},
		{assetKey: "fallbackImageAssetId", variantKey: "fallbackVariantId", label: "widget fallback image"},
	} {
		rawID, _ := configuration[reference.assetKey].(string)
		if rawID == "" {
			continue
		}
		assetID, err := uuid.Parse(rawID)
		if err != nil {
			return fmt.Errorf("%w: %s reference is invalid", ErrConflict, reference.label)
		}
		asset, resolveErr := s.resolveImageVariant(ctx, assetID)
		if resolveErr != nil {
			return fmt.Errorf("%w: %s unavailable", ErrConflict, reference.label)
		}
		configuration[reference.variantKey] = asset.VariantID.String()
		if !seen[asset.VariantID] {
			manifest.Assets = append(manifest.Assets, asset)
			seen[asset.VariantID] = true
		}
	}
	widget.Configuration, _ = json.Marshal(configuration)
	return nil
}

func (s *Service) resolveImageVariant(ctx context.Context, assetID uuid.UUID) (ManifestAsset, error) {
	asset, err := s.resolveAssetVariant(ctx, assetID, nil)
	if err != nil {
		return ManifestAsset{}, err
	}
	if !strings.HasPrefix(asset.MIMEType, "image/") {
		return ManifestAsset{}, fmt.Errorf("asset is not an image")
	}
	asset.DownloadPath = "/api/v1/player/assets/" + asset.AssetID.String() + "/variants/" + asset.VariantID.String()
	return asset, nil
}

// resolveAssetVariant is the one variant-selection rule used for Layout
// placements and fallbacks. A document may request an exact variant; legacy
// documents without one use the deterministic playback > original ordering.
func (s *Service) resolveAssetVariant(ctx context.Context, assetID uuid.UUID, requested *uuid.UUID) (ManifestAsset, error) {
	var asset ManifestAsset
	query := `SELECT v.asset_id,v.id,v.mime_type,encode(v.sha256,'hex'),v.file_size,v.width,v.height,v.duration_seconds,a.available_from,a.expires_at
		FROM asset_variants v JOIN assets a ON a.id=v.asset_id AND a.deleted_at IS NULL AND a.archived_at IS NULL AND a.origin='library' AND a.system_managed=FALSE AND a.processing_status='ready'
		WHERE v.asset_id=$1 AND v.deleted_at IS NULL AND v.player_compatible=TRUE`
	args := []any{assetID}
	if requested != nil {
		query += ` AND v.id=$2`
		args = append(args, *requested)
	}
	query += ` ORDER BY CASE v.kind WHEN 'playback' THEN 0 WHEN 'original' THEN 1 ELSE 2 END,v.id LIMIT 1`
	err := s.db.QueryRow(ctx, query, args...).Scan(&asset.AssetID, &asset.VariantID, &asset.MIMEType, &asset.SHA256, &asset.FileSize, &asset.Width, &asset.Height, &asset.DurationSeconds, &asset.AvailableFrom, &asset.ExpiresAt)
	if err != nil {
		return ManifestAsset{}, err
	}
	asset.DownloadPath = "/api/v1/player/assets/" + asset.AssetID.String() + "/variants/" + asset.VariantID.String()
	return asset, nil
}

// projectPluginAssets resolves media a built-in plugin references. Brand Bug is
// the only plugin with media today: its logo becomes a normal manifest asset so
// the Player verifies and caches it like any other image and keeps drawing the
// mark offline.
//
// A logo that has become unavailable since the instance was saved drops to a
// text-only mark rather than failing the manifest — one deleted image must not
// cost a screen its entire content.
func (s *Service) projectPluginAssets(ctx context.Context, manifest *Manifest, seen map[uuid.UUID]bool) error {
	kept := make([]plugins.ManifestPlugin, 0, len(manifest.Plugins))
	for _, plugin := range manifest.Plugins {
		config, ok := plugin.Config.(*plugins.ManifestBrandBugConfig)
		if !ok {
			kept = append(kept, plugin)
			continue
		}
		if err := s.resolveBrandBugLogo(ctx, manifest, config, seen); err != nil {
			return err
		}
		// A mark left with no logo and no text has nothing to draw; publishing it
		// would only give the Player an empty corner to reason about.
		if config.ImageAssetID != nil || strings.TrimSpace(config.Text) != "" {
			kept = append(kept, plugin)
		}
	}
	manifest.Plugins = kept
	return nil
}

func (s *Service) resolveBrandBugLogo(ctx context.Context, manifest *Manifest, config *plugins.ManifestBrandBugConfig, seen map[uuid.UUID]bool) error {
	if config.ImageAssetID == nil {
		return nil
	}
	asset, err := s.resolveImageVariant(ctx, *config.ImageAssetID)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		config.ImageAssetID = nil
		return nil
	}
	variantID := asset.VariantID
	config.ImageVariantID = &variantID
	config.ImageAvailableFrom = asset.AvailableFrom
	config.ImageExpiresAt = asset.ExpiresAt
	if !seen[asset.VariantID] {
		manifest.Assets = append(manifest.Assets, asset)
		seen[asset.VariantID] = true
	}
	return nil
}

// projectDataSource adds a Data Source to the manifest exactly once, projecting its bounded
// cached dataset and date-selection policy. The dataset is shared by every widget or binding
// that references the Data Source; it is never copied into a widget configuration.
func (s *Service) projectDataSource(ctx context.Context, manifest *Manifest, dataSourceID uuid.UUID) error {
	if dataSourceID == uuid.Nil {
		return nil
	}
	for _, existing := range manifest.DataSources {
		if existing.ID == dataSourceID {
			return nil
		}
	}
	var dataSource ManifestDataSource
	dataSource.ID = dataSourceID
	var raw json.RawMessage
	if err := s.db.QueryRow(ctx, `SELECT name,provider,config_version,configuration FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, dataSourceID).Scan(&dataSource.Name, &dataSource.Provider, &dataSource.ConfigVersion, &raw); err != nil {
		return fmt.Errorf("%w: required data Source unavailable", ErrConflict)
	}
	dataSource.Configuration = raw
	if s.sources != nil {
		var projected json.RawMessage
		var err error
		if manifest.SchemaVersion >= 12 {
			projected, err = s.sources.PlayerTypedDataSourceConfiguration(ctx, dataSourceID, dataSource.Provider, raw)
		} else {
			projected, err = s.sources.PlayerDataSourceConfiguration(ctx, dataSourceID, dataSource.Provider, raw)
		}
		if err != nil {
			return err
		}
		dataSource.Configuration = projected
	}
	manifest.DataSources = append(manifest.DataSources, dataSource)
	return nil
}

func uniqueUUIDs(values []uuid.UUID) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	result := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		if value == uuid.Nil || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

// AssetChanged invalidates the complete presentation dependency graph rooted at
// an asset. This includes layout placements, website/widget fallbacks, nested
// playlists, schedules, takeovers, overrides, and plugin overlays.
func (s *Service) AssetChanged(ctx context.Context, assetID uuid.UUID, reason string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	changes, err := s.AssetChangedInTx(ctx, tx, assetID, reason)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.NotifyManifestChanges(changes)
	return nil
}

func (s *Service) AssetChangedInTx(ctx context.Context, tx pgx.Tx, assetID uuid.UUID, reason string) ([]manifestchanges.Change, error) {
	notes, err := bumpResourcesInTx(ctx, tx, "asset", assetID, reason)
	return manifestChanges(notes), err
}

// LayoutChanged is used by the layout service after a draft is published or a
// layout is archived. Keeping the traversal here means layouts and media
// mutations cannot drift into different definitions of “affected screen”.
func (s *Service) LayoutChanged(ctx context.Context, layoutID uuid.UUID, reason string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	changes, err := s.LayoutChangedInTx(ctx, tx, layoutID, reason)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.NotifyManifestChanges(changes)
	return nil
}

func (s *Service) LayoutChangedInTx(ctx context.Context, tx pgx.Tx, layoutID uuid.UUID, reason string) ([]manifestchanges.Change, error) {
	notes, err := bumpResourcesInTx(ctx, tx, "layout", layoutID, reason)
	return manifestChanges(notes), err
}

// TagAssignmentsChanged invalidates every tag-driven playlist that references a changed tag.
// It intentionally does not depend on the asset's post-mutation tag set, so removing the final
// matching tag still delivers the now-shorter playlist to every affected screen.
func (s *Service) TagAssignmentsChanged(ctx context.Context, tagIDs []uuid.UUID, reason string) error {
	tagIDs = uniqueUUIDs(tagIDs)
	if len(tagIDs) == 0 {
		return nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	changes := []manifestchanges.Change{}
	for _, tagID := range tagIDs {
		changed, bumpErr := s.TagAssignmentsChangedInTx(ctx, tx, []uuid.UUID{tagID}, reason)
		if bumpErr != nil {
			return bumpErr
		}
		changes = append(changes, changed...)
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.NotifyManifestChanges(changes)
	return nil
}

func (s *Service) TagAssignmentsChangedInTx(ctx context.Context, tx pgx.Tx, tagIDs []uuid.UUID, reason string) ([]manifestchanges.Change, error) {
	changes := []manifestchanges.Change{}
	for _, tagID := range uniqueUUIDs(tagIDs) {
		notes, err := bumpResourcesInTx(ctx, tx, "tag", tagID, reason)
		if err != nil {
			return nil, err
		}
		changes = append(changes, manifestChanges(notes)...)
	}
	return changes, nil
}

// DataSourceChanged bumps manifests for screens whose widgets consume the Data Source
// (through any assigned playlist) or whose assigned Layout uses it via a contained widget
// or a direct text binding. The cached dataset is projected into the manifest, so a data
// change requires a fresh manifest for the affected screens.
func (s *Service) DataSourceChanged(ctx context.Context, dataSourceID uuid.UUID, reason string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	changes, err := s.DataSourceChangedInTx(ctx, tx, dataSourceID, reason)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.NotifyManifestChanges(changes)
	return nil
}

func (s *Service) DataSourceChangedInTx(ctx context.Context, tx pgx.Tx, dataSourceID uuid.UUID, reason string) ([]manifestchanges.Change, error) {
	notes, err := bumpResourcesInTx(ctx, tx, "data_source", dataSourceID, reason)
	return manifestChanges(notes), err
}

// InvalidatePluginInTx lets plugin-owned mutations participate in the same
// transaction as their manifest version bump. The callback receives the
// committed-event payload only after the traversal query has succeeded; the
// caller still emits it after its transaction commits.
func (s *Service) InvalidatePluginInTx(ctx context.Context, tx pgx.Tx, pluginType string, pluginID uuid.UUID, reason string, notify func(uuid.UUID, int64)) error {
	notes, err := bumpResourcesInTx(ctx, tx, "plugin", pluginID, reason+":"+pluginType)
	if err != nil {
		return err
	}
	for _, note := range notes {
		notify(note.screen, note.version)
	}
	return nil
}
func manifestETag(screenID uuid.UUID, version int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", screenID, version)))
	return `"manifest-` + hex.EncodeToString(sum[:]) + `"`
}

func manifestETagForSchema(screenID uuid.UUID, version int64, schemaVersion int) string {
	if schemaVersion <= 12 {
		return manifestETag(screenID, version)
	}
	value := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d", screenID, version, schemaVersion)))
	return `"sha256-` + hex.EncodeToString(value[:]) + `"`
}

// The set of one-time schedules in a manifest changes as entries cross the
// prefetch horizon or expire without a database mutation. Include that set in
// the validator so a player's periodic conditional request cannot receive a
// stale 304 at the horizon boundary.
func manifestETagForSchedules(base string, schedules []ManifestSchedule) string {
	if len(schedules) == 0 {
		return base
	}
	value := base
	for _, schedule := range schedules {
		action, _ := json.Marshal(schedule.DisplayAction)
		value += ":" + schedule.ID.String() + ":" + string(action)
	}
	sum := sha256.Sum256([]byte(value))
	return `"sha256-` + hex.EncodeToString(sum[:]) + `"`
}

func (s *Service) ReportStatus(ctx context.Context, screenID uuid.UUID, status PlayerStatus) error {
	if len(status.PlaybackState) > 80 || len(status.LastSyncError) > 500 || len(status.LastPlaybackError) > 500 || len(status.ScheduleEvaluationError) > 500 || len(status.WebsiteState) > 40 || len(status.WebsiteFailureCategory) > 80 || len(status.WebsiteCurrentHost) > 253 || len(status.WidgetState) > 40 || len(status.WidgetError) > 120 {
		return errors.New("player status is invalid")
	}
	widgetProviders := map[string]bool{"": true, "website": true, "youtube": true, "clock": true, "date": true, "qrcode": true, "ticker": true, "menu": true, "list": true, "table": true, "agenda": true}
	if !widgetProviders[status.WidgetProvider] {
		return errors.New("player widget status is invalid")
	}
	if status.SelectionSource != "" && status.SelectionSource != "takeover" && status.SelectionSource != "schedule" && status.SelectionSource != "direct_fallback" && status.SelectionSource != "none" {
		return errors.New("player status is invalid")
	}
	websiteStates := map[string]bool{"": true, "idle": true, "loading": true, "loaded": true, "refreshing": true, "failed": true, "timed_out": true, "blocked": true, "showing_fallback": true}
	websiteErrors := map[string]bool{"": true, "dns_failure": true, "connection_failure": true, "tls_failure": true, "http_error": true, "load_timeout": true, "blocked_navigation": true, "renderer_crash": true, "offline": true, "invalid_configuration": true, "unsupported_scheme": true, "unknown_webview_error": true}
	if !websiteStates[status.WebsiteState] || !websiteErrors[status.WebsiteFailureCategory] {
		return errors.New("player website status is invalid")
	}
	if status.DeviceClockOffsetSeconds != nil && (*status.DeviceClockOffsetSeconds < -604800 || *status.DeviceClockOffsetSeconds > 604800) {
		return errors.New("player status is invalid")
	}
	for _, value := range []*int64{status.DownloadedBytes, status.RequiredBytes, status.CacheUsedBytes, status.CacheLimitBytes} {
		if value != nil && *value < 0 {
			return errors.New("player status is invalid")
		}
	}
	if status.DownloadQueueCount != nil && *status.DownloadQueueCount < 0 {
		return errors.New("player status is invalid")
	}
	takeoverStates := map[string]bool{"": true, "pending": true, "notified": true, "preparing": true, "ready": true, "active": true, "failed": true, "offline": true, "restored": true, "expired": true, "cancelled": true}
	if !takeoverStates[status.TakeoverState] || status.TakeoverPreparationProgress != nil && (*status.TakeoverPreparationProgress < 0 || *status.TakeoverPreparationProgress > 100) {
		return errors.New("player takeover status is invalid")
	}
	for _, value := range []*int{status.WebsiteBlockedNavigationCount, status.WebsiteRendererRecoveryCount} {
		if value != nil && (*value < 0 || *value > 1000000) {
			return errors.New("player website status is invalid")
		}
	}
	_, err := s.db.Exec(ctx, `INSERT INTO screen_player_status(screen_id,active_manifest_version,pending_manifest_version,assigned_playlist_id,current_item_id,current_asset_id,playback_state,download_queue_count,downloaded_bytes,required_bytes,cache_used_bytes,cache_limit_bytes,last_sync_error,last_playback_error,current_schedule_id,current_playlist_id,selection_source,next_transition_at,device_clock_offset_seconds,schedule_evaluation_error,schedule_manifest_version,current_website_asset_id,website_state,website_load_started_at,website_load_completed_at,website_failure_category,website_blocked_navigation_count,website_current_host,website_fallback_shown,website_renderer_recovery_count,updated_at)VALUES($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,$9,$10,$11,$12,NULLIF($13,''),NULLIF($14,''),$15,$16,NULLIF($17,''),$18,$19,NULLIF($20,''),$21,$22,NULLIF($23,''),$24,$25,NULLIF($26,''),$27,NULLIF($28,''),$29,$30,now()) ON CONFLICT(screen_id)DO UPDATE SET active_manifest_version=EXCLUDED.active_manifest_version,pending_manifest_version=EXCLUDED.pending_manifest_version,assigned_playlist_id=EXCLUDED.assigned_playlist_id,current_item_id=EXCLUDED.current_item_id,current_asset_id=EXCLUDED.current_asset_id,playback_state=EXCLUDED.playback_state,download_queue_count=EXCLUDED.download_queue_count,downloaded_bytes=EXCLUDED.downloaded_bytes,required_bytes=EXCLUDED.required_bytes,cache_used_bytes=EXCLUDED.cache_used_bytes,cache_limit_bytes=EXCLUDED.cache_limit_bytes,last_sync_error=EXCLUDED.last_sync_error,last_playback_error=EXCLUDED.last_playback_error,current_schedule_id=EXCLUDED.current_schedule_id,current_playlist_id=EXCLUDED.current_playlist_id,selection_source=EXCLUDED.selection_source,next_transition_at=EXCLUDED.next_transition_at,device_clock_offset_seconds=EXCLUDED.device_clock_offset_seconds,schedule_evaluation_error=EXCLUDED.schedule_evaluation_error,schedule_manifest_version=EXCLUDED.schedule_manifest_version,current_website_asset_id=EXCLUDED.current_website_asset_id,website_state=EXCLUDED.website_state,website_load_started_at=COALESCE(EXCLUDED.website_load_started_at,screen_player_status.website_load_started_at),website_load_completed_at=COALESCE(EXCLUDED.website_load_completed_at,screen_player_status.website_load_completed_at),website_failure_category=COALESCE(EXCLUDED.website_failure_category,screen_player_status.website_failure_category),website_blocked_navigation_count=EXCLUDED.website_blocked_navigation_count,website_current_host=COALESCE(EXCLUDED.website_current_host,screen_player_status.website_current_host),website_fallback_shown=EXCLUDED.website_fallback_shown,website_renderer_recovery_count=EXCLUDED.website_renderer_recovery_count,updated_at=now()`, screenID, status.ActiveManifestVersion, status.PendingManifestVersion, status.AssignedPlaylistID, status.CurrentItemID, status.CurrentAssetID, status.PlaybackState, status.DownloadQueueCount, status.DownloadedBytes, status.RequiredBytes, status.CacheUsedBytes, status.CacheLimitBytes, status.LastSyncError, status.LastPlaybackError, status.CurrentScheduleID, status.CurrentPlaylistID, status.SelectionSource, status.NextTransitionAt, status.DeviceClockOffsetSeconds, status.ScheduleEvaluationError, status.ScheduleManifestVersion, status.CurrentWebsiteAssetID, status.WebsiteState, status.WebsiteLoadStartedAt, status.WebsiteLoadCompletedAt, status.WebsiteFailureCategory, status.WebsiteBlockedNavigationCount, status.WebsiteCurrentHost, status.WebsiteFallbackShown, status.WebsiteRendererRecoveryCount)
	if err == nil && status.CurrentWebsiteAssetID != nil {
		_, err = s.db.Exec(ctx, `UPDATE screen_player_status SET last_website_asset_id=$2 WHERE screen_id=$1`, screenID, status.CurrentWebsiteAssetID)
	}
	if err == nil && status.WebsiteFailureCategory != "" {
		_, err = s.db.Exec(ctx, `UPDATE screen_player_status SET website_failure_at=now() WHERE screen_id=$1`, screenID)
	}
	if err == nil {
		_, err = s.db.Exec(ctx, `UPDATE screen_player_status SET current_widget_id=$2,widget_provider=NULLIF($3,''),widget_state=NULLIF($4,''),widget_error=NULLIF($5,'') WHERE screen_id=$1`, screenID, status.CurrentWidgetID, status.WidgetProvider, status.WidgetState, status.WidgetError)
	}
	if err == nil {
		_, err = s.db.Exec(ctx, `UPDATE screen_player_status SET active_takeover_id=$2,takeover_state=NULLIF($3,''),takeover_preparation_progress=$4,playback_disabled=COALESCE($5,playback_disabled),last_command_id=COALESCE($6,last_command_id),last_command_state=COALESCE(NULLIF($7,''),last_command_state),last_command_result=COALESCE(NULLIF($8,''),last_command_result),last_command_completed_at=COALESCE($9,last_command_completed_at) WHERE screen_id=$1`, screenID, status.ActiveTakeoverID, status.TakeoverState, status.TakeoverPreparationProgress, status.PlaybackDisabled, status.LastCommandID, status.LastCommandState, status.LastCommandResult, status.LastCommandCompletedAt)
	}
	if err == nil && status.ActiveTakeoverID != nil && status.TakeoverState != "" {
		_, _ = s.db.Exec(ctx, `UPDATE takeover_screen_states SET state=$3,last_updated_at=now(),prepared_at=CASE WHEN $3 IN ('ready','active') THEN COALESCE(prepared_at,now()) ELSE prepared_at END,activated_at=CASE WHEN $3='active' THEN COALESCE(activated_at,now()) ELSE activated_at END WHERE takeover_id=$1 AND screen_id=$2`, status.ActiveTakeoverID, screenID, status.TakeoverState)
	}
	if err == nil {
		_, err = s.db.Exec(ctx, `UPDATE screen_player_status SET active_config_revision=$2,configuration_error=NULLIF($3,'') WHERE screen_id=$1`, screenID, status.ActiveConfigRevision, status.ConfigurationError)
		if status.ActiveConfigRevision != nil {
			_, _ = s.db.Exec(ctx, `UPDATE screen_config_state SET active_config_revision=$2 WHERE screen_id=$1`, screenID, status.ActiveConfigRevision)
		}
	}
	return err
}

func insertAudit(ctx context.Context, tx pgx.Tx, userID uuid.UUID, action string, id uuid.UUID) error {
	resource := "playlist"
	if strings.HasPrefix(action, "screen.") {
		resource = "screen"
	}
	_, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,$3,$4,$5)`, uuid.New(), userID, action, resource, id.String())
	return err
}
