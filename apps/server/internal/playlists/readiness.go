package playlists

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
)

// ErrPresentationNotReady is returned when a presentation cannot produce a
// player-safe manifest at the requested point in time. Callers should surface
// the wrapped detail to Studio, but must not activate the presentation.
var ErrPresentationNotReady = errors.New("presentation is not ready for playback")

// PresentationReadiness is intentionally small so the scheduling and
// presentation packages can use the same validator without importing the
// playlist implementation in the opposite direction.
type PresentationReadiness interface {
	ValidatePresentationInTx(context.Context, pgx.Tx, string, uuid.UUID, time.Time) error
	ValidatePresentationNowInTx(context.Context, pgx.Tx, string, uuid.UUID, time.Time) error
}

// ValidatePresentation validates all persisted dependencies without requiring
// the root to have an item that is available at this exact instant. That makes
// future-dated schedules assignable while still rejecting broken graph edges.
func (s *Service) ValidatePresentation(ctx context.Context, contentType string, id uuid.UUID, at time.Time) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err = s.ValidatePresentationInTx(ctx, tx, contentType, id, at); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ValidatePresentationNow is used by operations that must start immediately,
// such as Quick Present. It adds the stronger requirement that at least one
// currently available renderable path exists.
func (s *Service) ValidatePresentationNow(ctx context.Context, contentType string, id uuid.UUID, at time.Time) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err = s.ValidatePresentationNowInTx(ctx, tx, contentType, id, at); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) ValidatePresentationInTx(ctx context.Context, tx pgx.Tx, contentType string, id uuid.UUID, at time.Time) error {
	if id == uuid.Nil || (contentType != "playlist" && contentType != "layout" && contentType != "asset") {
		return fmt.Errorf("%w: content reference is invalid", ErrPresentationNotReady)
	}
	state := readinessState{tx: tx, at: at.UTC(), visited: map[string]bool{}, active: map[string]bool{}}
	switch contentType {
	case "playlist":
		return state.playlist(ctx, id, false)
	case "layout":
		return state.layout(ctx, id, false)
	case "asset":
		return state.asset(ctx, id, false)
	default:
		return fmt.Errorf("%w: unsupported content type", ErrPresentationNotReady)
	}
}

func (s *Service) ValidatePresentationNowInTx(ctx context.Context, tx pgx.Tx, contentType string, id uuid.UUID, at time.Time) error {
	if err := s.ValidatePresentationInTx(ctx, tx, contentType, id, at); err != nil {
		return err
	}
	state := readinessState{tx: tx, at: at.UTC(), visited: map[string]bool{}, active: map[string]bool{}}
	var err error
	switch contentType {
	case "playlist":
		err = state.playlist(ctx, id, true)
	case "layout":
		err = state.layout(ctx, id, true)
	case "asset":
		return state.asset(ctx, id, true)
	}
	return err
}

type readinessState struct {
	tx      pgx.Tx
	at      time.Time
	visited map[string]bool
	active  map[string]bool
}

func (s *readinessState) enter(kind string, id uuid.UUID) (func(), error) {
	key := kind + ":" + id.String()
	if s.active[key] {
		return nil, fmt.Errorf("%w: presentation graph contains a %s cycle", ErrPresentationNotReady, kind)
	}
	if s.visited[key] {
		return func() {}, nil
	}
	s.active[key] = true
	s.visited[key] = true
	return func() { delete(s.active, key) }, nil
}

func (s *readinessState) playlist(ctx context.Context, id uuid.UUID, requireAvailable bool) error {
	leave, err := s.enter("playlist", id)
	if err != nil {
		return err
	}
	defer leave()
	var name string
	if err = s.tx.QueryRow(ctx, `SELECT name FROM playlists WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&name); errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: playlist %s is deleted or missing", ErrPresentationNotReady, id)
	} else if err != nil {
		return err
	}
	rows, err := s.tx.Query(ctx, `SELECT id,asset_id,layout_id FROM playlist_items WHERE playlist_id=$1 ORDER BY position,id`, id)
	if err != nil {
		return err
	}
	// pgx does not permit a second query on the same connection while rows are
	// still being consumed. Materialize the tiny identity projection first so
	// nested playlist/layout validation can safely query through the same tx.
	type itemRef struct {
		id      uuid.UUID
		assetID uuid.UUID
		layout  *uuid.UUID
	}
	refs := []itemRef{}
	for rows.Next() {
		var ref itemRef
		if err = rows.Scan(&ref.id, &ref.assetID, &ref.layout); err != nil {
			rows.Close()
			return err
		}
		refs = append(refs, ref)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	count, available := 0, 0
	for _, ref := range refs {
		count++
		if ref.layout != nil {
			if err = s.layout(ctx, *ref.layout, false); err != nil {
				return fmt.Errorf("%w: playlist %q item %s: %v", ErrPresentationNotReady, name, ref.id, err)
			}
			if s.presentationAvailable(ctx, "layout", *ref.layout, map[string]bool{}) {
				available++
			}
			continue
		}
		if ref.assetID == uuid.Nil {
			return fmt.Errorf("%w: playlist %q item %s has no content", ErrPresentationNotReady, name, ref.id)
		}
		if err = s.asset(ctx, ref.assetID, false); err != nil {
			return fmt.Errorf("%w: playlist %q item %s: %v", ErrPresentationNotReady, name, ref.id, err)
		}
		if s.renderableAssetAvailable(ctx, ref.assetID) {
			available++
		}
	}
	if count == 0 {
		return fmt.Errorf("%w: playlist %q is empty", ErrPresentationNotReady, name)
	}
	if requireAvailable && available == 0 {
		return fmt.Errorf("%w: playlist %q has no currently available content", ErrPresentationNotReady, name)
	}
	return nil
}

func (s *readinessState) layout(ctx context.Context, id uuid.UUID, requireAvailable bool) error {
	leave, err := s.enter("layout", id)
	if err != nil {
		return err
	}
	defer leave()
	var name string
	var revisionID uuid.UUID
	var raw []byte
	if err = s.tx.QueryRow(ctx, `SELECT l.name,r.id,r.document FROM layouts l JOIN layout_revisions r ON r.id=l.published_revision_id WHERE l.id=$1 AND l.deleted_at IS NULL`, id).Scan(&name, &revisionID, &raw); errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: layout %s is deleted, missing, or unpublished", ErrPresentationNotReady, id)
	} else if err != nil {
		return err
	}
	var document layouts.Document
	if err = json.Unmarshal(raw, &document); err != nil {
		return fmt.Errorf("%w: layout %q document is invalid: %v", ErrPresentationNotReady, name, err)
	}
	if err = layouts.ValidateDocument(document); err != nil {
		return fmt.Errorf("%w: layout %q is invalid: %v", ErrPresentationNotReady, name, err)
	}
	available := 0
	if document.Canvas.BackgroundAssetID != nil {
		if err = s.imageAsset(ctx, *document.Canvas.BackgroundAssetID, false); err != nil {
			return fmt.Errorf("%w: layout %q background: %v", ErrPresentationNotReady, name, err)
		}
		backgroundVariantAvailable := document.Canvas.BackgroundVariantID == nil ||
			s.variantAvailable(ctx, *document.Canvas.BackgroundAssetID, *document.Canvas.BackgroundVariantID)
		if !backgroundVariantAvailable {
			return fmt.Errorf("%w: layout %q background variant is unavailable", ErrPresentationNotReady, name)
		}
		if s.imageAssetAvailable(ctx, *document.Canvas.BackgroundAssetID) &&
			backgroundVariantAvailable {
			available++
		}
	}
	hasVisiblePath := false
	for _, placement := range document.Placements {
		if !placement.Visible {
			continue
		}
		hasVisiblePath = true
		switch placement.Type {
		case "asset":
			if placement.AssetID == nil {
				return fmt.Errorf("%w: layout %q asset placement is missing its asset", ErrPresentationNotReady, name)
			}
			if err = s.asset(ctx, *placement.AssetID, false); err != nil {
				return fmt.Errorf("%w: layout %q asset placement: %v", ErrPresentationNotReady, name, err)
			}
			if placement.VariantID != nil && !s.variantAvailable(ctx, *placement.AssetID, *placement.VariantID) {
				return fmt.Errorf("%w: layout %q asset placement variant is unavailable", ErrPresentationNotReady, name)
			}
			if s.renderableAssetAvailable(ctx, *placement.AssetID) {
				available++
			}
		case "widget":
			if placement.WidgetID == nil {
				return fmt.Errorf("%w: layout %q widget placement is missing its widget", ErrPresentationNotReady, name)
			}
			if err = s.widget(ctx, *placement.WidgetID, false); err != nil {
				return fmt.Errorf("%w: layout %q widget placement: %v", ErrPresentationNotReady, name, err)
			}
			if s.widgetAvailable(ctx, *placement.WidgetID) {
				available++
			}
		case "playlistZone":
			if placement.PlaylistID == nil {
				return fmt.Errorf("%w: layout %q playlist zone is missing its playlist", ErrPresentationNotReady, name)
			}
			if err = layouts.ValidatePlaylistZoneMediaOnly(ctx, s.tx, placement.PlaylistID); err != nil {
				return fmt.Errorf("%w: layout %q playlist zone: %v", ErrPresentationNotReady, name, err)
			}
			if err = s.playlist(ctx, *placement.PlaylistID, false); err != nil {
				return fmt.Errorf("%w: layout %q playlist zone: %v", ErrPresentationNotReady, name, err)
			}
			if s.presentationAvailable(ctx, "playlist", *placement.PlaylistID, map[string]bool{}) {
				available++
			}
		case "primitive":
			if placement.Primitive != nil && placement.Primitive.Binding != nil {
				if err = s.dataSource(ctx, placement.Primitive.Binding.DataSourceID); err != nil {
					return fmt.Errorf("%w: layout %q binding: %v", ErrPresentationNotReady, name, err)
				}
			}
			available++
		}
	}
	// A layout containing only a background is still renderable. A completely
	// empty layout is valid content (its canvas is intentional), so only reject
	// it in strict-now mode when it has no renderable canvas at all.
	if requireAvailable && available == 0 &&
		(document.Canvas.BackgroundAssetID != nil || hasVisiblePath) {
		return fmt.Errorf("%w: layout %q has no currently available content", ErrPresentationNotReady, name)
	}
	_ = revisionID // the revision is selected above to make draft/unpublished bypass impossible.
	return nil
}

func (s *readinessState) asset(ctx context.Context, id uuid.UUID, requireAvailable bool) error {
	var kind, status, origin string
	var archived, system bool
	var availableFrom, expiresAt *time.Time
	if err := s.tx.QueryRow(ctx, `SELECT type,processing_status,origin,archived_at IS NOT NULL,system_managed,available_from,expires_at FROM assets WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&kind, &status, &origin, &archived, &system, &availableFrom, &expiresAt); errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: asset %s is deleted or missing", ErrPresentationNotReady, id)
	} else if err != nil {
		return err
	}
	// System-managed widgets (for example the built-in alert presentation) are
	// still renderable player content even though they are hidden from the
	// ordinary library. Other system-managed/generated assets must not bypass
	// the library-readiness boundary.
	if (origin != "library" && !(system && kind == "widget")) || archived || status != "ready" || (system && kind != "widget") {
		return fmt.Errorf("%w: asset %s is not ready", ErrPresentationNotReady, id)
	}
	if availableFrom != nil && expiresAt != nil && !availableFrom.Before(*expiresAt) {
		return fmt.Errorf("%w: asset %s has an invalid availability window", ErrPresentationNotReady, id)
	}
	if kind == "image" || kind == "video" {
		var variant bool
		if err := s.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM asset_variants WHERE asset_id=$1 AND deleted_at IS NULL AND player_compatible=TRUE)`, id).Scan(&variant); err != nil {
			return err
		}
		if !variant {
			return fmt.Errorf("%w: asset %s has no player-compatible variant", ErrPresentationNotReady, id)
		}
	}
	if kind == "widget" {
		if err := s.widget(ctx, id, requireAvailable); err != nil {
			return err
		}
	}
	if requireAvailable && !windowAvailable(availableFrom, expiresAt, s.at) {
		return fmt.Errorf("%w: asset %s is outside its availability window", ErrPresentationNotReady, id)
	}
	return nil
}

func (s *readinessState) widget(ctx context.Context, id uuid.UUID, requireAvailable bool) error {
	if err := s.widgetAsset(ctx, id, requireAvailable); err != nil {
		return err
	}
	var provider string
	var configuration []byte
	if err := s.tx.QueryRow(ctx, `SELECT w.provider,w.configuration FROM widgets w JOIN assets a ON a.id=w.asset_id WHERE w.asset_id=$1 AND a.deleted_at IS NULL`, id).Scan(&provider, &configuration); errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: widget %s is missing", ErrPresentationNotReady, id)
	} else if err != nil {
		return err
	}
	if provider == "website" {
		var exists bool
		if err := s.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM website_assets WHERE asset_id=$1)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("%w: website widget %s has no website configuration", ErrPresentationNotReady, id)
		}
		var fallback *uuid.UUID
		if err := s.tx.QueryRow(ctx, `SELECT fallback_image_asset_id FROM website_assets WHERE asset_id=$1`, id).Scan(&fallback); err != nil {
			return err
		}
		if fallback != nil {
			if err := s.imageAsset(ctx, *fallback, requireAvailable); err != nil {
				return fmt.Errorf("%w: website fallback: %v", ErrPresentationNotReady, err)
			}
		}
	}
	return s.validateReferencedConfiguration(ctx, configuration, requireAvailable)
}

// widgetAsset applies the same asset lifecycle boundary as ordinary media to
// widget-backed assets. Keeping this check separate avoids recursing through
// asset -> widget while still making layout widget placements reject archived,
// processing, or time-unavailable widget assets.
func (s *readinessState) widgetAsset(ctx context.Context, id uuid.UUID, requireAvailable bool) error {
	var kind, status, origin string
	var archived, system bool
	var availableFrom, expiresAt *time.Time
	if err := s.tx.QueryRow(ctx, `SELECT type,processing_status,origin,archived_at IS NOT NULL,system_managed,available_from,expires_at FROM assets WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&kind, &status, &origin, &archived, &system, &availableFrom, &expiresAt); errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: widget %s is deleted or missing", ErrPresentationNotReady, id)
	} else if err != nil {
		return err
	}
	if kind != "widget" || (origin != "library" && !(system && kind == "widget")) || archived || status != "ready" {
		return fmt.Errorf("%w: widget %s is not ready", ErrPresentationNotReady, id)
	}
	if availableFrom != nil && expiresAt != nil && !availableFrom.Before(*expiresAt) {
		return fmt.Errorf("%w: widget %s has an invalid availability window", ErrPresentationNotReady, id)
	}
	if requireAvailable && !windowAvailable(availableFrom, expiresAt, s.at) {
		return fmt.Errorf("%w: widget %s is outside its availability window", ErrPresentationNotReady, id)
	}
	return nil
}

// imageAsset is the shared boundary for every alternate image path. A
// fallback that points at a video, widget, or other asset type may look like a
// valid UUID in authoring data, but the player cannot render it as an image.
// Checking the type before asset() also avoids recursing through a malformed
// widget-to-widget fallback graph.
func (s *readinessState) imageAsset(ctx context.Context, id uuid.UUID, requireAvailable bool) error {
	var kind string
	if err := s.tx.QueryRow(ctx, `SELECT type FROM assets WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&kind); errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: image asset %s is deleted or missing", ErrPresentationNotReady, id)
	} else if err != nil {
		return err
	}
	if kind != "image" {
		return fmt.Errorf("%w: asset %s is not an image", ErrPresentationNotReady, id)
	}
	return s.asset(ctx, id, requireAvailable)
}

// widgetAvailable is the strict-now counterpart to widget. A widget can be
// structurally valid while its configured image or website fallback is outside
// its availability window. Those alternate paths must not make a layout look
// ready when the renderer has no drawable content at this instant.
func (s *readinessState) widgetAvailable(ctx context.Context, id uuid.UUID) bool {
	if err := s.widgetAsset(ctx, id, true); err != nil {
		return false
	}
	var provider string
	var configuration []byte
	if err := s.tx.QueryRow(ctx, `SELECT w.provider,w.configuration FROM widgets w JOIN assets a ON a.id=w.asset_id WHERE w.asset_id=$1 AND a.deleted_at IS NULL`, id).Scan(&provider, &configuration); err != nil {
		return false
	}
	var values any
	if len(configuration) == 0 || json.Unmarshal(configuration, &values) != nil {
		return false
	}
	if err := s.walkConfiguration(ctx, values, true); err != nil {
		return false
	}
	if provider == "website" {
		var fallback *uuid.UUID
		if err := s.tx.QueryRow(ctx, `SELECT fallback_image_asset_id FROM website_assets WHERE asset_id=$1`, id).Scan(&fallback); err != nil {
			return false
		}
		if fallback != nil && !s.imageAssetAvailable(ctx, *fallback) {
			return false
		}
	}
	return true
}

func (s *readinessState) validateReferencedConfiguration(ctx context.Context, raw []byte, requireAvailable bool) error {
	var values any
	if len(raw) == 0 || json.Unmarshal(raw, &values) != nil {
		return fmt.Errorf("%w: widget configuration is invalid", ErrPresentationNotReady)
	}
	return s.walkConfiguration(ctx, values, requireAvailable)
}

func (s *readinessState) walkConfiguration(ctx context.Context, value any, requireAvailable bool) error {
	switch item := value.(type) {
	case []any:
		for _, child := range item {
			if err := s.walkConfiguration(ctx, child, requireAvailable); err != nil {
				return err
			}
		}
	case map[string]any:
		for key, child := range item {
			switch strings.ToLower(key) {
			case "datasourceid", "data_source_id":
				id, err := uuid.Parse(fmt.Sprint(child))
				if err != nil || id == uuid.Nil {
					return fmt.Errorf("%w: widget references an invalid data Source", ErrPresentationNotReady)
				}
				if err = s.dataSource(ctx, id); err != nil {
					return err
				}
			case "fallbackimageassetid", "imageassetid":
				if text, ok := child.(string); ok && text != "" {
					id, err := uuid.Parse(text)
					if err != nil {
						return fmt.Errorf("%w: widget image fallback is invalid", ErrPresentationNotReady)
					}
					if err = s.imageAsset(ctx, id, requireAvailable); err != nil {
						return err
					}
				}
			}
			if err := s.walkConfiguration(ctx, child, requireAvailable); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *readinessState) dataSource(ctx context.Context, id uuid.UUID) error {
	var exists bool
	if err := s.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM data_sources WHERE id=$1 AND deleted_at IS NULL)`, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%w: data Source %s is deleted or missing", ErrPresentationNotReady, id)
	}
	return nil
}

func (s *readinessState) variantAvailable(ctx context.Context, assetID, variantID uuid.UUID) bool {
	var exists bool
	_ = s.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM asset_variants v JOIN assets a ON a.id=v.asset_id WHERE v.id=$1 AND v.asset_id=$2 AND v.deleted_at IS NULL AND v.player_compatible=TRUE AND a.deleted_at IS NULL AND a.processing_status='ready')`, variantID, assetID).Scan(&exists)
	return exists
}

func (s *readinessState) assetAvailable(ctx context.Context, id uuid.UUID) bool {
	var from, until *time.Time
	return s.tx.QueryRow(ctx, `SELECT available_from,expires_at FROM assets WHERE id=$1`, id).Scan(&from, &until) == nil && windowAvailable(from, until, s.at)
}

func (s *readinessState) imageAssetAvailable(ctx context.Context, id uuid.UUID) bool {
	return s.imageAsset(ctx, id, true) == nil
}

// renderableAssetAvailable keeps strict-now readiness aligned with the
// renderer. Widget assets have their own drawable dependencies (configured
// images and website fallbacks), so an available widget row alone is not proof
// that the player can render it.
func (s *readinessState) renderableAssetAvailable(ctx context.Context, id uuid.UUID) bool {
	var kind string
	if err := s.tx.QueryRow(ctx, `SELECT type FROM assets WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&kind); err != nil {
		return false
	}
	if !s.assetAvailable(ctx, id) {
		return false
	}
	return kind != "widget" || s.widgetAvailable(ctx, id)
}

// presentationAvailable is the strict-now half of readiness. It follows the
// same graph as validation, but treats a future/expired leaf as unavailable
// instead of failing the whole parent. This is what lets a playlist keep a
// valid fallback item while a scheduled item is outside its window, and lets
// the root validator reject only when every renderable path is unavailable.
func (s *readinessState) presentationAvailable(ctx context.Context, kind string, id uuid.UUID, active map[string]bool) bool {
	key := kind + ":" + id.String()
	if active[key] {
		return false
	}
	active[key] = true
	defer delete(active, key)
	switch kind {
	case "asset":
		return s.renderableAssetAvailable(ctx, id)
	case "playlist":
		rows, err := s.tx.Query(ctx, `SELECT asset_id,layout_id FROM playlist_items WHERE playlist_id=$1 ORDER BY position,id`, id)
		if err != nil {
			return false
		}
		type itemRef struct {
			assetID uuid.UUID
			layout  *uuid.UUID
		}
		refs := []itemRef{}
		for rows.Next() {
			var ref itemRef
			if rows.Scan(&ref.assetID, &ref.layout) != nil {
				rows.Close()
				return false
			}
			refs = append(refs, ref)
		}
		if rows.Err() != nil {
			rows.Close()
			return false
		}
		rows.Close()
		for _, ref := range refs {
			if ref.layout != nil {
				if s.presentationAvailable(ctx, "layout", *ref.layout, active) {
					return true
				}
			} else if ref.assetID != uuid.Nil && s.renderableAssetAvailable(ctx, ref.assetID) {
				return true
			}
		}
		return false
	case "layout":
		var raw []byte
		if err := s.tx.QueryRow(ctx, `SELECT r.document FROM layouts l JOIN layout_revisions r ON r.id=l.published_revision_id WHERE l.id=$1 AND l.deleted_at IS NULL`, id).Scan(&raw); err != nil {
			return false
		}
		var document layouts.Document
		if json.Unmarshal(raw, &document) != nil {
			return false
		}
		if document.Canvas.BackgroundAssetID != nil && s.imageAssetAvailable(ctx, *document.Canvas.BackgroundAssetID) {
			if document.Canvas.BackgroundVariantID == nil || s.variantAvailable(ctx, *document.Canvas.BackgroundAssetID, *document.Canvas.BackgroundVariantID) {
				return true
			}
		}
		visiblePath := false
		for _, placement := range document.Placements {
			if !placement.Visible {
				continue
			}
			switch placement.Type {
			case "asset":
				if placement.AssetID == nil {
					continue
				}
				visiblePath = true
				if s.renderableAssetAvailable(ctx, *placement.AssetID) && (placement.VariantID == nil || s.variantAvailable(ctx, *placement.AssetID, *placement.VariantID)) {
					return true
				}
			case "playlistZone":
				if placement.PlaylistID == nil {
					continue
				}
				visiblePath = true
				if s.presentationAvailable(ctx, "playlist", *placement.PlaylistID, active) {
					return true
				}
			case "widget":
				visiblePath = true
				if placement.WidgetID != nil && s.widgetAvailable(ctx, *placement.WidgetID) {
					return true
				}
			case "primitive":
				// A primitive/data-source binding remains a drawable path even when
				// the source has no rows; structural validation already checked the
				// data source reference.
				visiblePath = true
				return true
			}
		}
		// An intentionally empty canvas is valid content. A layout that has
		// visible paths but none available is not.
		return !visiblePath
	default:
		return false
	}
}

func windowAvailable(from, until *time.Time, at time.Time) bool {
	return (from == nil || !from.After(at)) && (until == nil || until.After(at))
}

var _ PresentationReadiness = (*Service)(nil)
