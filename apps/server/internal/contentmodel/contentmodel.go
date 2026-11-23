// Package contentmodel builds the read-only content models that Content
// Health passes to plugin checks (docs/plugin-providers.md). A model is
// built from the public API model of its domain service, never from a
// database row, and keeps only what a check of the content needs: no users,
// no usage by other content or screens, no previews, and no credentials.
//
// The model is versioned (plugin.ContentItemModelVersion) so that a later
// phase can serialize it to installed plugins.
package contentmodel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Model bounds.
const (
	// MaxPlaylistItems bounds the items of a playlist model.
	MaxPlaylistItems = 500
	// MaxDocumentBytes bounds a Layout document or a Widget configuration.
	MaxDocumentBytes = 64 << 10
)

// The errors of Model are Content Health's, so its sweep can tell a removed
// item from a failure.
var (
	ErrGone     = contenthealth.ErrItemGone
	ErrTooLarge = contenthealth.ErrItemTooLarge
)

// Builder lists content items and builds their models.
type Builder struct {
	db        *pgxpool.Pool
	playlists *playlists.Service
	layouts   *layouts.Service
	media     *media.Service
}

// NewBuilder makes a builder on the domain services.
func NewBuilder(db *pgxpool.Pool, playlistService *playlists.Service, layoutService *layouts.Service, mediaService *media.Service) *Builder {
	return &Builder{db: db, playlists: playlistService, layouts: layoutService, media: mediaService}
}

// listQueries select the IDs of each kind's library content.
var listQueries = map[string]string{
	plugin.ContentKindPlaylist: `SELECT id FROM playlists WHERE deleted_at IS NULL ORDER BY id`,
	plugin.ContentKindLayout:   `SELECT id FROM layouts WHERE deleted_at IS NULL ORDER BY id`,
	plugin.ContentKindWidgetInstance: `SELECT id FROM assets WHERE deleted_at IS NULL AND archived_at IS NULL
		AND origin='library' AND system_managed=FALSE AND type='widget' ORDER BY id`,
	plugin.ContentKindMediaItem: `SELECT id FROM assets WHERE deleted_at IS NULL AND archived_at IS NULL
		AND origin='library' AND system_managed=FALSE AND type NOT IN ('widget','website') ORDER BY id`,
}

// IDs lists the items of a kind.
func (b *Builder) IDs(ctx context.Context, kind string) ([]uuid.UUID, error) {
	query, ok := listQueries[kind]
	if !ok {
		return nil, fmt.Errorf("unknown content kind %q", kind)
	}
	rows, err := b.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// Model builds the model of one item. It answers ErrGone for an item that
// no longer exists or is not of the kind.
func (b *Builder) Model(ctx context.Context, kind string, id uuid.UUID) (plugin.ContentItem, error) {
	item := plugin.ContentItem{Kind: kind, ID: id.String(), ModelVersion: plugin.ContentItemModelVersion}
	switch kind {
	case plugin.ContentKindPlaylist:
		playlist, err := b.playlists.Get(ctx, id)
		if errors.Is(err, playlists.ErrNotFound) {
			return item, ErrGone
		}
		if err != nil {
			return item, err
		}
		if len(playlist.Items) > MaxPlaylistItems {
			return item, ErrTooLarge
		}
		item.Name, item.Description = playlist.Name, playlist.Description
		model := &plugin.ContentPlaylist{SourceType: playlist.SourceType, Items: []plugin.ContentPlaylistItem{}}
		for _, entry := range playlist.Items {
			out := plugin.ContentPlaylistItem{ID: entry.ID.String(), AssetID: entry.AssetID.String(), AssetName: entry.AssetName,
				AssetType: entry.AssetType, AssetStatus: entry.AssetStatus, WidgetProvider: entry.WidgetProvider,
				DurationMS: entry.DurationMS, FitMode: entry.FitMode, AvailableFrom: entry.AvailableFrom, ExpiresAt: entry.ExpiresAt}
			if entry.LayoutID != nil {
				out.LayoutID = entry.LayoutID.String()
			}
			model.Items = append(model.Items, out)
		}
		item.Playlist = model
	case plugin.ContentKindLayout:
		layout, err := b.layouts.Get(ctx, id)
		if errors.Is(err, layouts.ErrNotFound) {
			return item, ErrGone
		}
		if err != nil {
			return item, err
		}
		document, err := json.Marshal(layout.Draft)
		if err != nil {
			return item, err
		}
		if len(document) > MaxDocumentBytes {
			return item, ErrTooLarge
		}
		item.Name, item.Description = layout.Name, layout.Description
		item.Layout = &plugin.ContentLayout{Orientation: layout.Orientation, CanvasWidth: layout.CanvasWidth,
			CanvasHeight: layout.CanvasHeight, Document: document}
	case plugin.ContentKindWidgetInstance, plugin.ContentKindMediaItem:
		asset, err := b.media.GetAsset(ctx, id)
		if errors.Is(err, media.ErrNotFound) {
			return item, ErrGone
		}
		if err != nil {
			return item, err
		}
		widget := asset.Type == "widget"
		if asset.ArchivedAt != nil || widget != (kind == plugin.ContentKindWidgetInstance) || asset.Type == "website" {
			return item, ErrGone
		}
		item.Name, item.Description = asset.Name, asset.Description
		if widget {
			if asset.Widget == nil {
				return item, ErrGone
			}
			if len(asset.Widget.Configuration) > MaxDocumentBytes {
				return item, ErrTooLarge
			}
			configuration := asset.Widget.Configuration
			if len(configuration) == 0 {
				configuration = json.RawMessage(`{}`)
			}
			item.Widget = &plugin.ContentWidget{Provider: asset.Widget.Provider, ConfigVersion: asset.Widget.ConfigVersion, Configuration: configuration}
		} else {
			item.Media = &plugin.ContentMedia{Type: asset.Type, MIMEType: asset.DetectedMIMEType, Width: asset.Width, Height: asset.Height,
				DurationSeconds: asset.Duration, ProcessingStatus: string(asset.ProcessingStatus),
				AvailableFrom: asset.AvailableFrom, ExpiresAt: asset.ExpiresAt}
		}
	default:
		return item, fmt.Errorf("unknown content kind %q", kind)
	}
	return item, nil
}
