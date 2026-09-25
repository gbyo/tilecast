package layouts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/ids"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
)

const MaxPreviewImageBytes = 500 * 1024

type Notifier interface{ ManifestChanged(uuid.UUID, int64) }
type ManifestInvalidator interface {
	LayoutChanged(context.Context, uuid.UUID, string) error
}
type TransactionalManifestInvalidator interface {
	LayoutChangedInTx(context.Context, pgx.Tx, uuid.UUID, string) ([]manifestchanges.Change, error)
	NotifyManifestChanges([]manifestchanges.Change)
}
type Service struct {
	db               *pgxpool.Pool
	notifier         Notifier
	invalidator      ManifestInvalidator
	publicationGuard func(context.Context, uuid.UUID, uuid.UUID, int64) error
}

func NewService(db *pgxpool.Pool) *Service       { return &Service{db: db} }
func (s *Service) SetNotifier(notifier Notifier) { s.notifier = notifier }
func (s *Service) SetManifestInvalidator(invalidator ManifestInvalidator) {
	s.invalidator = invalidator
}

// SetPublicationGuard lets the application-level editorial workflow own the
// authorization boundary while keeping this low-level service safe for any
// remaining callers.
func (s *Service) SetPublicationGuard(guard func(context.Context, uuid.UUID, uuid.UUID, int64) error) {
	s.publicationGuard = guard
}

func defaultDocument(orientation string, width, height int) Document {
	return Document{SchemaVersion: 2, Canvas: Canvas{Width: width, Height: height, Orientation: orientation, BackgroundColor: "#0E141B", SafeAreaPercent: 5}, Placements: []Placement{}}
}

func validateDetails(name, description, orientation string, width, height int) error {
	name = strings.TrimSpace(name)
	if len(name) < 1 || len(name) > 180 {
		return errors.New("layout name must be between 1 and 180 characters")
	}
	if len(description) > 2000 {
		return errors.New("layout description must be at most 2000 characters")
	}
	return ValidateDocument(defaultDocument(orientation, width, height))
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, name, description, orientation string, width, height int) (Layout, error) {
	name, description = strings.TrimSpace(name), strings.TrimSpace(description)
	if err := validateDetails(name, description, orientation, width, height); err != nil {
		return Layout{}, err
	}
	var org uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&org); err != nil {
		return Layout{}, err
	}
	document := defaultDocument(orientation, width, height)
	encoded, _ := json.Marshal(document)
	id := ids.New(ctx)
	_, err := s.db.Exec(ctx, `INSERT INTO layouts(id,organization_id,name,description,orientation,canvas_width,canvas_height,draft_document,created_by,updated_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, id, org, name, description, orientation, width, height, encoded, userID)
	if err != nil {
		return Layout{}, err
	}
	_ = s.audit(ctx, userID, "layout.created", id)
	return s.Get(ctx, id)
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
	var result ListResult
	result.Page, result.PageSize = page, pageSize
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM layouts WHERE deleted_at IS NULL AND($1='' OR name ILIKE '%'||$1||'%')`, search).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := s.db.Query(ctx, `SELECT l.id,l.name,l.description,l.orientation,l.canvas_width,l.canvas_height,l.draft_revision,r.revision,r.published_at,CASE WHEN r.id IS NULL THEN FALSE ELSE l.draft_document IS DISTINCT FROM r.document END,l.created_at,l.updated_at,l.preview_image IS NOT NULL FROM layouts l LEFT JOIN layout_revisions r ON r.id=l.published_revision_id WHERE l.deleted_at IS NULL AND($1='' OR l.name ILIKE '%'||$1||'%') ORDER BY l.updated_at DESC,l.id LIMIT $2 OFFSET $3`, search, pageSize, (page-1)*pageSize)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	result.Items = []Summary{}
	for rows.Next() {
		var item Summary
		var hasPreview bool
		if err = rows.Scan(&item.ID, &item.Name, &item.Description, &item.Orientation, &item.CanvasWidth, &item.CanvasHeight, &item.DraftRevision, &item.PublishedRevision, &item.PublishedAt, &item.HasUnpublishedChanges, &item.CreatedAt, &item.UpdatedAt, &hasPreview); err != nil {
			return result, err
		}
		if hasPreview {
			item.PreviewImageURL = "/api/v1/layouts/" + item.ID.String() + "/preview-image"
		}
		result.Items = append(result.Items, item)
	}
	return result, rows.Err()
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Layout, error) {
	var result Layout
	var raw []byte
	result.ID = id
	var hasPreview bool
	err := s.db.QueryRow(ctx, `SELECT l.name,l.description,l.orientation,l.canvas_width,l.canvas_height,l.draft_document,l.draft_revision,l.published_revision_id,r.revision,r.published_at,CASE WHEN r.id IS NULL THEN FALSE ELSE l.draft_document IS DISTINCT FROM r.document END,l.created_at,l.updated_at,l.preview_image IS NOT NULL FROM layouts l LEFT JOIN layout_revisions r ON r.id=l.published_revision_id WHERE l.id=$1 AND l.deleted_at IS NULL`, id).Scan(&result.Name, &result.Description, &result.Orientation, &result.CanvasWidth, &result.CanvasHeight, &raw, &result.DraftRevision, &result.PublishedRevisionID, &result.PublishedRevision, &result.PublishedAt, &result.HasUnpublishedChanges, &result.CreatedAt, &result.UpdatedAt, &hasPreview)
	if errors.Is(err, pgx.ErrNoRows) {
		return Layout{}, ErrNotFound
	}
	if err != nil {
		return Layout{}, err
	}
	if err = json.Unmarshal(raw, &result.Draft); err != nil {
		return Layout{}, err
	}
	if hasPreview {
		result.PreviewImageURL = "/api/v1/layouts/" + result.ID.String() + "/preview-image"
	}
	result.Dependencies, err = s.draftDependencies(ctx, id)
	if err != nil {
		return Layout{}, err
	}
	result.Usage = Usage{Screens: []UsageItem{}, Schedules: []UsageItem{}, Campaigns: []UsageItem{}}
	rows, err := s.db.Query(ctx, `SELECT DISTINCT sc.id,sc.name FROM screens sc LEFT JOIN screen_playlist_assignments a ON a.screen_id=sc.id LEFT JOIN screen_group_memberships m ON m.screen_id=sc.id LEFT JOIN screen_group_playlist_assignments ga ON ga.screen_group_id=m.screen_group_id WHERE a.layout_id=$1 OR ga.layout_id=$1 ORDER BY sc.name`, id)
	if err != nil {
		return Layout{}, err
	}
	for rows.Next() {
		var item UsageItem
		if err = rows.Scan(&item.ID, &item.Name); err != nil {
			rows.Close()
			return Layout{}, err
		}
		result.Usage.Screens = append(result.Usage.Screens, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return Layout{}, err
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `SELECT id,name FROM schedules WHERE layout_id=$1 AND deleted_at IS NULL ORDER BY name`, id)
	if err != nil {
		return Layout{}, err
	}
	for rows.Next() {
		var item UsageItem
		if err = rows.Scan(&item.ID, &item.Name); err != nil {
			rows.Close()
			return Layout{}, err
		}
		result.Usage.Schedules = append(result.Usage.Schedules, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return Layout{}, err
	}
	rows.Close()
	campaignRows, err := s.db.Query(ctx, `SELECT DISTINCT c.id,c.name FROM campaigns c LEFT JOIN schedules s ON s.campaign_id=c.id AND s.layout_id=$1 AND s.deleted_at IS NULL WHERE c.archived_at IS NULL AND (s.id IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.draft->'blocks')='array' THEN c.draft->'blocks' ELSE '[]'::jsonb END) block WHERE block->>'contentType'='layout' AND block->>'contentId'=$1::text)) ORDER BY c.name`, id)
	if err != nil {
		return Layout{}, err
	}
	defer campaignRows.Close()
	for campaignRows.Next() {
		var item UsageItem
		if err = campaignRows.Scan(&item.ID, &item.Name); err != nil {
			return Layout{}, err
		}
		result.Usage.Campaigns = append(result.Usage.Campaigns, item)
	}
	return result, campaignRows.Err()
}

func (s *Service) UpdateDetails(ctx context.Context, id, userID uuid.UUID, name, description string) (Layout, error) {
	current, err := s.Get(ctx, id)
	if err != nil {
		return Layout{}, err
	}
	name, description = strings.TrimSpace(name), strings.TrimSpace(description)
	if err = validateDetails(name, description, current.Orientation, current.CanvasWidth, current.CanvasHeight); err != nil {
		return Layout{}, err
	}
	command, err := s.db.Exec(ctx, `UPDATE layouts SET name=$1,description=$2,updated_by=$3,updated_at=now() WHERE id=$4 AND deleted_at IS NULL`, name, description, userID, id)
	if err != nil {
		return Layout{}, err
	}
	if command.RowsAffected() == 0 {
		return Layout{}, ErrNotFound
	}
	_ = s.audit(ctx, userID, "layout.updated", id)
	return s.Get(ctx, id)
}

func (s *Service) SaveDraft(ctx context.Context, id, userID uuid.UUID, expected int64, document Document) (Layout, error) {
	if err := ValidateDocument(document); err != nil {
		return Layout{}, err
	}
	deps := Dependencies(document)
	if err := s.validateDependencies(ctx, deps); err != nil {
		return Layout{}, err
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return Layout{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Layout{}, err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `UPDATE layouts SET draft_document=$1,draft_revision=draft_revision+1,orientation=$2,canvas_width=$3,canvas_height=$4,preview_image=NULL,preview_content_type=NULL,preview_width=NULL,preview_height=NULL,preview_updated_at=NULL,updated_by=$5,updated_at=now() WHERE id=$6 AND deleted_at IS NULL AND draft_revision=$7`, encoded, document.Canvas.Orientation, document.Canvas.Width, document.Canvas.Height, userID, id, expected)
	if err != nil {
		return Layout{}, err
	}
	if command.RowsAffected() == 0 {
		var exists bool
		_ = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM layouts WHERE id=$1 AND deleted_at IS NULL)`, id).Scan(&exists)
		if !exists {
			return Layout{}, ErrNotFound
		}
		return Layout{}, ErrConflict
	}
	if err = s.replaceDraftDependencies(ctx, tx, id, deps); err != nil {
		return Layout{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Layout{}, err
	}
	return s.Get(ctx, id)
}

func validatePreviewImage(data []byte, canvasWidth, canvasHeight int) (int, int, error) {
	if len(data) < 1 || len(data) > MaxPreviewImageBytes {
		return 0, 0, fmt.Errorf("layout preview image must be between 1 and %d bytes", MaxPreviewImageBytes)
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 960 || config.Height > 960 {
		return 0, 0, errors.New("layout preview image must be a JPEG no larger than 960 by 960")
	}
	difference := config.Width*canvasHeight - config.Height*canvasWidth
	if difference < 0 {
		difference = -difference
	}
	if difference*200 > config.Width*canvasHeight {
		return 0, 0, errors.New("layout preview image aspect ratio must match the Layout canvas")
	}
	return config.Width, config.Height, nil
}

func (s *Service) StorePreviewImage(ctx context.Context, id, userID uuid.UUID, expectedRevision int64, data []byte) error {
	var canvasWidth, canvasHeight int
	if err := s.db.QueryRow(ctx, `SELECT canvas_width,canvas_height FROM layouts WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&canvasWidth, &canvasHeight); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	width, height, err := validatePreviewImage(data, canvasWidth, canvasHeight)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `UPDATE layouts SET preview_image=$2,preview_content_type='image/jpeg',preview_width=$3,preview_height=$4,preview_updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND draft_revision=$5`, id, data, width, height, expectedRevision)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM layouts WHERE id=$1 AND deleted_at IS NULL)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		return ErrConflict
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'layout.preview.updated','layout',$3)`, uuid.New(), userID, id.String()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) PreviewImage(ctx context.Context, id uuid.UUID) (PreviewImage, error) {
	var image PreviewImage
	err := s.db.QueryRow(ctx, `SELECT preview_image,preview_content_type,preview_width,preview_height,preview_updated_at FROM layouts WHERE id=$1 AND deleted_at IS NULL AND preview_image IS NOT NULL`, id).Scan(&image.Data, &image.ContentType, &image.Width, &image.Height, &image.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return PreviewImage{}, ErrNotFound
	}
	return image, err
}

func (s *Service) Publish(ctx context.Context, id, userID uuid.UUID, expected int64) (Revision, error) {
	if s.publicationGuard != nil {
		if err := s.publicationGuard(ctx, id, userID, expected); err != nil {
			return Revision{}, err
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Revision{}, err
	}
	defer tx.Rollback(ctx)
	var raw []byte
	var current int64
	err = tx.QueryRow(ctx, `SELECT draft_document,draft_revision FROM layouts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&raw, &current)
	if errors.Is(err, pgx.ErrNoRows) {
		return Revision{}, ErrNotFound
	}
	if err != nil {
		return Revision{}, err
	}
	if current != expected {
		return Revision{}, ErrConflict
	}
	var document Document
	if err = json.Unmarshal(raw, &document); err != nil {
		return Revision{}, err
	}
	if err = ValidateDocument(document); err != nil {
		return Revision{}, err
	}
	deps := Dependencies(document)
	if err = s.validateDependenciesTx(ctx, tx, deps); err != nil {
		return Revision{}, err
	}
	if err = s.validatePlaybackLimitsTx(ctx, tx, document); err != nil {
		return Revision{}, err
	}
	if err = s.validateStructuredBindingsTx(ctx, tx, document); err != nil {
		return Revision{}, err
	}
	canonical, _ := json.Marshal(document)
	sum := sha256.Sum256(canonical)
	digest := hex.EncodeToString(sum[:])
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE(max(revision),0)+1 FROM layout_revisions WHERE layout_id=$1`, id).Scan(&revision); err != nil {
		return Revision{}, err
	}
	revisionID := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO layout_revisions(id,layout_id,revision,document,document_sha256,published_by)VALUES($1,$2,$3,$4,$5,$6)`, revisionID, id, revision, canonical, digest, userID)
	if err != nil {
		return Revision{}, err
	}
	for _, dep := range deps {
		if _, err = tx.Exec(ctx, `INSERT INTO layout_revision_dependencies(revision_id,dependency_type,dependency_id)VALUES($1,$2,$3)`, revisionID, dep.Type, dep.ID); err != nil {
			return Revision{}, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE layouts SET published_revision_id=$1,updated_by=$2,updated_at=now() WHERE id=$3`, revisionID, userID, id)
	if err != nil {
		return Revision{}, err
	}
	if err = insertAuditTx(ctx, tx, userID, "layout.published", id); err != nil {
		return Revision{}, err
	}
	var changes []manifestchanges.Change
	transactionalUsed := false
	if transactional, ok := s.invalidator.(TransactionalManifestInvalidator); ok {
		transactionalUsed = true
		changes, err = transactional.LayoutChangedInTx(ctx, tx, id, "layout.published")
		if err != nil {
			return Revision{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Revision{}, err
	}
	if transactionalUsed {
		s.invalidator.(TransactionalManifestInvalidator).NotifyManifestChanges(changes)
	} else if s.invalidator != nil {
		if err := s.invalidator.LayoutChanged(ctx, id, "layout.published"); err != nil {
			return Revision{}, err
		}
	}
	return s.GetRevision(ctx, id, revisionID)
}

func (s *Service) Revisions(ctx context.Context, id uuid.UUID, page, pageSize int) (RevisionList, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	result := RevisionList{Items: []Revision{}, Page: page, PageSize: pageSize}
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM layout_revisions WHERE layout_id=$1`, id).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := s.db.Query(ctx, `SELECT id,revision,document,document_sha256,published_by,published_at FROM layout_revisions WHERE layout_id=$1 ORDER BY revision DESC LIMIT $2 OFFSET $3`, id, pageSize, (page-1)*pageSize)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var item Revision
		var raw []byte
		item.LayoutID = id
		if err = rows.Scan(&item.ID, &item.Revision, &raw, &item.DocumentSHA256, &item.PublishedBy, &item.PublishedAt); err != nil {
			return result, err
		}
		if err = json.Unmarshal(raw, &item.Document); err != nil {
			return result, err
		}
		result.Items = append(result.Items, item)
	}
	if result.Total == 0 {
		var exists bool
		if err = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM layouts WHERE id=$1 AND deleted_at IS NULL)`, id).Scan(&exists); err != nil {
			return result, err
		}
		if !exists {
			return result, ErrNotFound
		}
	}
	return result, rows.Err()
}

func (s *Service) GetRevision(ctx context.Context, layoutID, revisionID uuid.UUID) (Revision, error) {
	var result Revision
	var raw []byte
	result.ID = revisionID
	result.LayoutID = layoutID
	err := s.db.QueryRow(ctx, `SELECT revision,document,document_sha256,published_by,published_at FROM layout_revisions WHERE id=$1 AND layout_id=$2`, revisionID, layoutID).Scan(&result.Revision, &raw, &result.DocumentSHA256, &result.PublishedBy, &result.PublishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Revision{}, ErrNotFound
	}
	if err != nil {
		return Revision{}, err
	}
	err = json.Unmarshal(raw, &result.Document)
	return result, err
}

func (s *Service) Restore(ctx context.Context, id, revisionID, userID uuid.UUID, expected int64) (Layout, error) {
	revision, err := s.GetRevision(ctx, id, revisionID)
	if err != nil {
		return Layout{}, err
	}
	return s.SaveDraft(ctx, id, userID, expected, revision.Document)
}

func (s *Service) Duplicate(ctx context.Context, id, userID uuid.UUID) (Layout, error) {
	source, err := s.Get(ctx, id)
	if err != nil {
		return Layout{}, err
	}
	copy, err := s.Create(ctx, userID, source.Name+" copy", source.Description, source.Orientation, source.CanvasWidth, source.CanvasHeight)
	if err != nil {
		return Layout{}, err
	}
	return s.SaveDraft(ctx, copy.ID, userID, copy.DraftRevision, source.Draft)
}

func (s *Service) Delete(ctx context.Context, id, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var inUse bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screen_playlist_assignments WHERE layout_id=$1) OR EXISTS(SELECT 1 FROM screen_group_playlist_assignments WHERE layout_id=$1) OR EXISTS(SELECT 1 FROM schedules WHERE layout_id=$1 AND deleted_at IS NULL) OR EXISTS(SELECT 1 FROM playlist_items WHERE layout_id=$1)`, id).Scan(&inUse); err != nil {
		return err
	}
	if inUse {
		return ErrInUse
	}
	command, err := tx.Exec(ctx, `UPDATE layouts SET deleted_at=now(),updated_by=$1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL`, userID, id)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err = insertAuditTx(ctx, tx, userID, "layout.deleted", id); err != nil {
		return err
	}
	var changes []manifestchanges.Change
	transactionalUsed := false
	if transactional, ok := s.invalidator.(TransactionalManifestInvalidator); ok {
		transactionalUsed = true
		changes, err = transactional.LayoutChangedInTx(ctx, tx, id, "layout.deleted")
		if err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if transactionalUsed {
		s.invalidator.(TransactionalManifestInvalidator).NotifyManifestChanges(changes)
	} else if s.invalidator != nil {
		if err := s.invalidator.LayoutChanged(ctx, id, "layout.deleted"); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) draftDependencies(ctx context.Context, id uuid.UUID) ([]Dependency, error) {
	rows, err := s.db.Query(ctx, `SELECT dependency_type,dependency_id FROM layout_draft_dependencies WHERE layout_id=$1 ORDER BY dependency_type,dependency_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Dependency{}
	for rows.Next() {
		var item Dependency
		if err = rows.Scan(&item.Type, &item.ID); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}
func (s *Service) replaceDraftDependencies(ctx context.Context, tx pgx.Tx, id uuid.UUID, deps []Dependency) error {
	if _, err := tx.Exec(ctx, `DELETE FROM layout_draft_dependencies WHERE layout_id=$1`, id); err != nil {
		return err
	}
	for _, dep := range deps {
		if _, err := tx.Exec(ctx, `INSERT INTO layout_draft_dependencies(layout_id,dependency_type,dependency_id)VALUES($1,$2,$3)`, id, dep.Type, dep.ID); err != nil {
			return err
		}
	}
	return nil
}
func (s *Service) validateDependencies(ctx context.Context, deps []Dependency) error {
	return s.validateDependencyQuery(ctx, s.db, deps)
}
func (s *Service) validatePlaybackLimitsTx(ctx context.Context, tx pgx.Tx, document Document) error {
	videoCapable, audioEmitting := 0, 0
	for _, placement := range document.Placements {
		if !placement.Visible {
			continue
		}
		video, audio := false, false
		switch placement.Type {
		case "asset":
			var assetType string
			if err := tx.QueryRow(ctx, `SELECT type FROM assets WHERE id=$1`, placement.AssetID).Scan(&assetType); err != nil {
				return err
			}
			video = assetType == "video"
			audio = video && (placement.Playback == nil || !placement.Playback.Muted)
		case "widget":
			var provider string
			if err := tx.QueryRow(ctx, `SELECT provider FROM widgets WHERE asset_id=$1`, placement.WidgetID).Scan(&provider); err != nil {
				return err
			}
			video = provider == "website" || provider == "youtube"
			muted := false
			if len(placement.Overrides) > 0 {
				var overrides struct {
					Muted *bool `json:"muted"`
				}
				_ = json.Unmarshal(placement.Overrides, &overrides)
				muted = overrides.Muted != nil && *overrides.Muted
			}
			audio = video && !muted
		case "playlistZone":
			if err := tx.QueryRow(ctx, `SELECT EXISTS(
				SELECT 1 FROM playlist_items i LEFT JOIN assets a ON a.id=i.asset_id
				LEFT JOIN widgets src ON src.asset_id=a.id
				WHERE i.playlist_id=$1 AND (i.layout_id IS NOT NULL OR a.type='video' OR src.provider IN ('website','youtube'))
			)`, placement.PlaylistID).Scan(&video); err != nil {
				return err
			}
			audio = video && (placement.Playback == nil || !placement.Playback.Muted)
		}
		if video {
			videoCapable++
		}
		if audio {
			audioEmitting++
		}
	}
	if videoCapable > 1 {
		return errors.New("layout may contain only one visible video-capable placement or playlist zone")
	}
	if audioEmitting > 1 {
		return errors.New("layout may contain only one audio-emitting placement or playlist zone")
	}
	return nil
}

// validateStructuredBindingsTx checks that each custom text binding references an existing
// Data Source of a bindable provider. Unlike Widgets, a bound Data Source is NOT placed in
// the Layout; the binding references it directly by dataSourceId.
func (s *Service) validateStructuredBindingsTx(ctx context.Context, tx pgx.Tx, document Document) error {
	for _, placement := range document.Placements {
		if placement.Primitive == nil || placement.Primitive.Binding == nil {
			continue
		}
		binding := placement.Primitive.Binding
		var provider string
		if err := tx.QueryRow(ctx, `SELECT provider FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, binding.DataSourceID).Scan(&provider); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errors.New("structured binding references an unknown data Source")
			}
			return err
		}
		if provider != "csv" && provider != "json" {
			return errors.New("structured binding requires a CSV or JSON data Source")
		}
	}
	return nil
}

func (s *Service) validateDependenciesTx(ctx context.Context, tx pgx.Tx, deps []Dependency) error {
	return s.validateDependencyQuery(ctx, tx, deps)
}

type queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (s *Service) validateDependencyQuery(ctx context.Context, q queryer, deps []Dependency) error {
	for _, dep := range deps {
		var valid bool
		switch dep.Type {
		case "widget":
			err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assets a JOIN widgets s ON s.asset_id=a.id WHERE a.id=$1 AND a.deleted_at IS NULL AND a.processing_status='ready')`, dep.ID).Scan(&valid)
			if err != nil {
				return err
			}
		case "data_source":
			err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM data_sources WHERE id=$1 AND deleted_at IS NULL)`, dep.ID).Scan(&valid)
			if err != nil {
				return err
			}
		case "asset":
			err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1 AND deleted_at IS NULL AND processing_status='ready')`, dep.ID).Scan(&valid)
			if err != nil {
				return err
			}
		case "playlist":
			err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM playlists WHERE id=$1 AND deleted_at IS NULL)`, dep.ID).Scan(&valid)
			if err != nil {
				return err
			}
		default:
			return errors.New("layout dependency type is invalid")
		}
		if !valid {
			return fmt.Errorf("layout %s dependency %s is unavailable", dep.Type, dep.ID)
		}
	}
	return nil
}
func (s *Service) audit(ctx context.Context, userID uuid.UUID, action string, id uuid.UUID) error {
	_, err := s.db.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,$3,'layout',$4)`, uuid.New(), userID, action, id.String())
	return err
}
func insertAuditTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, action string, id uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,$3,'layout',$4)`, uuid.New(), userID, action, id.String())
	return err
}
