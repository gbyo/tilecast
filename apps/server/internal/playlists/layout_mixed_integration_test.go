package playlists

import (
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"strings"
	"testing"
	"time"
)

func TestMixedLayoutManifestReadinessAndTransitiveUpdates(t *testing.T) {
	f := setupCapabilityFixture(t)
	playlist, err := f.service.Create(f.ctx, f.user, "Mixed rotation", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	image, _ := insertReadinessImage(t, f)
	video, videoVariant := insertReadinessImage(t, f)
	if _, err = f.pool.Exec(f.ctx, `UPDATE assets SET type='video',detected_mime_type='video/mp4',duration_seconds=8 WHERE id=$1`, video); err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(f.ctx, `UPDATE asset_variants SET mime_type='video/mp4',duration_seconds=8 WHERE id=$1`, videoVariant); err != nil {
		t.Fatal(err)
	}
	clock, err := f.media.CreateWidget(f.ctx, f.user, media.WidgetInput{Provider: "clock", Name: "Clock", Configuration: json.RawMessage(`{"timezone":"UTC","format":"24","showSeconds":false}`)})
	if err != nil {
		t.Fatal(err)
	}
	source := f.createSchoolStatusSource(t, "Status")
	configuration, _ := json.Marshal(map[string]any{"dataSourceId": source.String(), "heading": "Status", "statusField": "status", "messageField": "message", "severityField": "severity", "showUpdatedTime": true, "foregroundColor": "#ffffff", "backgroundColor": "#17324d", "emptyState": "Unavailable"})
	banner, err := f.media.CreateWidget(f.ctx, f.user, media.WidgetInput{Provider: "school-status-banner", Name: "Banner", Configuration: configuration})
	if err != nil {
		t.Fatal(err)
	}
	duration, start, end := int64(1234), int64(1000), int64(4000)
	for _, id := range []uuid.UUID{image, clock.ID, video, banner.ID} {
		input := ItemInput{AssetID: id, DurationMS: &duration, Transition: "crossfade"}
		if id == video {
			input.VideoStartOffsetMS = &start
			input.VideoEndOffsetMS = &end
		}
		if _, err = f.service.AddItem(f.ctx, playlist.ID, f.user, input); err != nil {
			t.Fatal(err)
		}
	}
	publishDraftForTest(t, f.ctx, f.service, playlist.ID, f.user)
	service := layouts.NewService(f.pool)
	service.SetManifestInvalidator(f.service)
	layout, err := service.Create(f.ctx, f.user, "Mixed Layout", "", "landscape", 1920, 1080)
	if err != nil {
		t.Fatal(err)
	}
	document := layouts.Document{SchemaVersion: 2, Canvas: layouts.Canvas{Width: 1920, Height: 1080, Orientation: "landscape", BackgroundColor: "#000000"}, Placements: []layouts.Placement{
		{ID: uuid.New(), Type: "playlistZone", Name: "Mixed", X: 0, Y: 0, Width: 960, Height: 1080, Visible: true, Opacity: 1, PlaylistID: &playlist.ID, Playback: &layouts.Playback{Loop: true, Muted: true}},
		{ID: uuid.New(), Type: "widget", Name: "Neighbor", X: 960, Y: 0, Width: 960, Height: 1080, Visible: true, Opacity: 1, WidgetID: &clock.ID},
	}}
	layout, err = service.SaveDraft(f.ctx, layout.ID, f.user, layout.DraftRevision, document)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Publish(f.ctx, layout.ID, f.user, layout.DraftRevision); err != nil {
		t.Fatal(err)
	}
	if err = f.service.ValidatePresentationNow(f.ctx, "layout", layout.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	f.reportCapabilities(t, "{1,2,3}", map[string]int{"widget.tilecast.clock": 2, "widget.tilecast.status": 1, layoutPlaylistWidgetsCapability: 0})
	if _, err = f.service.AssignPresentation(f.ctx, f.screen, nil, &layout.ID, f.user); !errors.Is(err, ErrConflict) || !strings.Contains(err.Error(), "layout.playlist_widgets@1") {
		t.Fatalf("unsupported Player accepted: %v", err)
	}
	f.reportCapabilities(t, "{1,2,3}", map[string]int{"widget.tilecast.clock": 2, "widget.tilecast.status": 1, layoutPlaylistWidgetsCapability: 1})
	if _, err = f.service.AssignPresentation(f.ctx, f.screen, nil, &layout.ID, f.user); err != nil {
		t.Fatal(err)
	}
	manifest, etag, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Widgets) != 2 || len(manifest.DataSources) != 1 || len(manifest.Assets) != 2 || len(manifest.Playlists) != 1 {
		t.Fatalf("missing nested resources: %+v", manifest)
	}
	for index, kind := range []string{"image", "widget", "video", "widget"} {
		if manifest.Playlists[0].Items[index].AssetType != kind {
			t.Fatalf("item %d lost ordering", index)
		}
	}
	if manifest.Playlists[0].Items[2].VideoStartOffsetMS == nil || *manifest.Playlists[0].Items[2].VideoEndOffsetMS != end {
		t.Fatal("video offsets lost")
	}
	for _, widget := range manifest.Widgets {
		if widget.Presentation == nil || widget.Presentation.RequiredCapabilities[layoutPlaylistWidgetsCapability] != 1 {
			t.Fatalf("zone requirement absent: %+v", widget)
		}
	}
	for _, change := range []struct {
		name  string
		apply func() error
	}{
		{"Widget", func() error { return f.service.AssetChanged(f.ctx, banner.ID, "test.widget.changed") }},
		{"Media", func() error { return f.service.AssetChanged(f.ctx, image, "test.media.changed") }},
		{"Data Source", func() error { return f.service.DataSourceChanged(f.ctx, source, "test.source.changed") }},
		{"Plugin", func() error {
			tx, err := f.pool.Begin(f.ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(f.ctx)
			_, err = bumpResourcesInTx(f.ctx, tx, "plugin", uuid.New(), "test.plugin.changed")
			if err != nil {
				return err
			}
			return tx.Commit(f.ctx)
		}},
	} {
		if _, err = f.pool.Exec(f.ctx, `UPDATE layouts SET preview_image=$2,preview_content_type='image/jpeg',preview_width=960,preview_height=540,preview_updated_at=now(),preview_capture_version=1 WHERE id=$1`, layout.ID, []byte{1}); err != nil {
			t.Fatal(err)
		}
		if err = change.apply(); err != nil {
			t.Fatal(err)
		}
		next, nextETag, err := f.service.BuildManifest(f.ctx, f.screen)
		if err != nil {
			t.Fatal(err)
		}
		if next.ManifestVersion <= manifest.ManifestVersion || nextETag == etag {
			t.Fatalf("%s change did not refresh mixed Layout", change.name)
		}
		if _, err = service.PreviewImage(f.ctx, layout.ID); !errors.Is(err, layouts.ErrNotFound) {
			t.Fatalf("%s retained stale preview: %v", change.name, err)
		}
		manifest, etag = next, nextETag
	}
	if _, err = f.pool.Exec(f.ctx, `UPDATE screen_player_status SET native_presentation_capabilities=native_presentation_capabilities-'layout.playlist_widgets' WHERE screen_id=$1`, f.screen); err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.service.BuildManifest(f.ctx, f.screen); !errors.Is(err, ErrConflict) {
		t.Fatalf("existing assignment bypassed capability gate: %v", err)
	}
	if _, err = f.pool.Exec(f.ctx, `UPDATE assets SET archived_at=now() WHERE id=$1`, banner.ID); err != nil {
		t.Fatal(err)
	}
	if err = f.service.ValidatePresentation(f.ctx, "layout", layout.ID, time.Now()); !errors.Is(err, ErrPresentationNotReady) {
		t.Fatalf("archived zone Widget accepted: %v", err)
	}
}
