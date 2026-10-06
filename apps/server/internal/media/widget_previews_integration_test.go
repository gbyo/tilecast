package media

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// widgetSnapshot builds the 960x540 JPEG the dashboard captures and uploads.
func widgetSnapshot(t *testing.T) []byte {
	t.Helper()
	frame := image.NewRGBA(image.Rect(0, 0, 960, 540))
	for y := 0; y < 540; y++ {
		for x := 0; x < 960; x++ {
			frame.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 120, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, frame, &jpeg.Options{Quality: 82}); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

// A stored Widget snapshot is the only preview the library has, and only a browser can produce one.
// It therefore has to survive every edit that cannot change what it depicts; discarding it on an
// unrelated edit leaves the Widget with no preview until someone reopens the editor and saves.
func TestWidgetPreviewSurvivesEditsThatDoNotChangeWhatItDepicts(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE data_source_refresh_states,data_sources,widgets,website_assets,asset_variants,assets,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Previews", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, nil, Config{
		Website:     WebsitePolicy{DefaultTimeoutSeconds: 20, MaxTimeoutSeconds: 120, MinRefreshSeconds: 30, MaxAllowedHosts: 25, MaxWebsites: 500},
		SourceFetch: SourceFetchPolicy{AllowPrivateNetworks: true, Timeout: 5 * time.Second, MaximumBytes: 1 << 20, MaximumRedirects: 3, MinimumRefresh: 5 * time.Minute, MaximumRefresh: 24 * time.Hour},
	})
	user := owner.User.ID
	configuration := `{"timezone":"UTC","format":"24","showSeconds":false,"foregroundColor":"#ffffff","backgroundColor":"#111111"}`

	widget, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "clock", Name: "Lobby clock", Configuration: json.RawMessage(configuration)})
	if err != nil {
		t.Fatal(err)
	}
	if widget.ThumbnailURL != nil {
		t.Fatalf("a new Widget has no snapshot yet: %v", *widget.ThumbnailURL)
	}
	if err := service.StoreWidgetPreview(ctx, widget.ID, user, widgetSnapshot(t)); err != nil {
		t.Fatal(err)
	}
	stored, err := service.GetAsset(ctx, widget.ID)
	if err != nil || stored.ThumbnailURL == nil {
		t.Fatalf("stored snapshot should be reported as a thumbnail: %#v %v", stored, err)
	}
	version, err := json.Marshal(stored.Metadata["widgetPreviewCaptureVersion"])
	if err != nil || string(version) != "4" {
		t.Fatalf("stored snapshot should record capture version %d: %s %v", WidgetPreviewCaptureVersion, version, err)
	}

	// Renaming a Widget cannot change what its snapshot depicts.
	renamed, err := service.UpdateWidget(ctx, widget.ID, user, WidgetInput{Provider: "clock", Name: "Front desk clock", Description: "Reworded", Configuration: json.RawMessage(configuration)})
	if err != nil {
		t.Fatal(err)
	}
	if renamed.ThumbnailURL == nil {
		t.Error("renaming a Widget discarded its snapshot, leaving the library with no preview")
	}
	if _, err := service.WidgetPreview(ctx, widget.ID); err != nil {
		t.Errorf("the snapshot image should still be servable after a rename: %v", err)
	}

	// Changing what the Widget shows does invalidate the snapshot: it no longer depicts the Widget.
	restyled, err := service.UpdateWidget(ctx, widget.ID, user, WidgetInput{Provider: "clock", Name: "Front desk clock", Configuration: json.RawMessage(`{"timezone":"UTC","format":"12","showSeconds":true,"foregroundColor":"#ff0000","backgroundColor":"#111111"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if restyled.ThumbnailURL != nil {
		t.Error("a configuration change must discard the stale snapshot")
	}
}

// Duplicating a Widget copies its configuration, so the original's snapshot depicts the copy too.
func TestDuplicatedWidgetKeepsTheSnapshotItDepicts(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE data_source_refresh_states,data_sources,widgets,website_assets,asset_variants,assets,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Previews", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, nil, Config{
		Website:     WebsitePolicy{DefaultTimeoutSeconds: 20, MaxTimeoutSeconds: 120, MinRefreshSeconds: 30, MaxAllowedHosts: 25, MaxWebsites: 500},
		SourceFetch: SourceFetchPolicy{AllowPrivateNetworks: true, Timeout: 5 * time.Second, MaximumBytes: 1 << 20, MaximumRedirects: 3, MinimumRefresh: 5 * time.Minute, MaximumRefresh: 24 * time.Hour},
	})
	user := owner.User.ID

	widget, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "clock", Name: "Lobby clock", Configuration: json.RawMessage(`{"timezone":"UTC","format":"24","showSeconds":false,"foregroundColor":"#ffffff","backgroundColor":"#111111"}`)})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := widgetSnapshot(t)
	if err := service.StoreWidgetPreview(ctx, widget.ID, user, snapshot); err != nil {
		t.Fatal(err)
	}

	copied, err := service.DuplicateWidget(ctx, widget.ID, user)
	if err != nil {
		t.Fatal(err)
	}
	if copied.ThumbnailURL == nil {
		t.Fatal("a duplicate renders what the original renders, so it should carry the snapshot")
	}
	image, err := service.WidgetPreview(ctx, copied.ID)
	if err != nil {
		t.Fatalf("duplicate snapshot should be servable: %v", err)
	}
	if !bytes.Equal(image.Data, snapshot) {
		t.Error("the duplicate should carry the original's snapshot image")
	}
	version, err := json.Marshal(copied.Metadata["widgetPreviewCaptureVersion"])
	if err != nil || string(version) != "4" {
		t.Fatalf("duplicate should keep capture version %d: %s %v", WidgetPreviewCaptureVersion, version, err)
	}

	// A duplicate of a Widget that never had a snapshot still has none, and must not fail.
	bare, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "clock", Name: "Bare clock", Configuration: json.RawMessage(`{"timezone":"UTC","format":"24","showSeconds":false,"foregroundColor":"#ffffff","backgroundColor":"#222222"}`)})
	if err != nil {
		t.Fatal(err)
	}
	bareCopy, err := service.DuplicateWidget(ctx, bare.ID, user)
	if err != nil {
		t.Fatalf("duplicating a Widget without a snapshot must still succeed: %v", err)
	}
	if bareCopy.ThumbnailURL != nil {
		t.Error("a duplicate cannot invent a snapshot the original never had")
	}
}
