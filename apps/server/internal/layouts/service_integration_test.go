package layouts

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

func TestLayoutDraftPublishAndRestoreLifecycle(t *testing.T) {
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
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE layouts, sessions, audit_logs, users, organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Layout Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool)
	var organizationID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	assetID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by)VALUES($1,$2,'Logo','image','logo.png','image/png',$3,100,400,200,'ready',$4)`, assetID, organizationID, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	layout, err := service.Create(ctx, owner.User.ID, "Lobby board", "", "landscape", 1920, 1080)
	if err != nil {
		t.Fatal(err)
	}
	if err = service.StorePreviewImage(ctx, layout.ID, owner.User.ID, layout.DraftRevision, jpegPreview(t, 960, 540)); err != nil {
		t.Fatal(err)
	}
	listed, err := service.List(ctx, "Lobby", 1, 10)
	if err != nil || len(listed.Items) != 1 || listed.Items[0].PreviewImageURL == "" {
		t.Fatalf("listed Layout preview: %#v err=%v", listed, err)
	}
	if preview, previewErr := service.PreviewImage(ctx, layout.ID); previewErr != nil || preview.Width != 960 || preview.Height != 540 {
		t.Fatalf("stored Layout preview: %#v err=%v", preview, previewErr)
	}
	document := validTestDocument()
	document.Placements = append(document.Placements, Placement{ID: uuid.New(), Type: "asset", Name: "Logo", X: 1200, Y: 40, Width: 400, Height: 200, Layer: 2, Opacity: 1, Visible: true, AssetID: &assetID})
	layout, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, layout.DraftRevision, document)
	if err != nil {
		t.Fatal(err)
	}
	if err = service.StorePreviewImage(ctx, layout.ID, owner.User.ID, layout.DraftRevision-1, jpegPreview(t, 960, 540)); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale Layout preview revision was accepted: %v", err)
	}
	if _, err = service.PreviewImage(ctx, layout.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("draft change did not clear the stale Layout preview: %v", err)
	}
	if _, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, 1, document); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
	published, err := service.Publish(ctx, layout.ID, owner.User.ID, layout.DraftRevision)
	if err != nil {
		t.Fatal(err)
	}
	if published.Revision != 1 || published.DocumentSHA256 == "" {
		t.Fatalf("published=%#v", published)
	}
	listed, err = service.List(ctx, "Lobby", 1, 10)
	if err != nil || len(listed.Items) != 1 || listed.Items[0].HasUnpublishedChanges {
		t.Fatalf("published Layout was reported as having unpublished changes: %#v err=%v", listed, err)
	}
	if err = media.NewService(pool, nil, media.Config{}).DeleteAsset(ctx, assetID, owner.User.ID); err == nil || !strings.Contains(err.Error(), "Layout") {
		t.Fatalf("referenced asset deletion err=%v", err)
	}
	document.Placements[0].Primitive.Text = "Changed draft"
	layout, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, layout.DraftRevision, document)
	if err != nil {
		t.Fatal(err)
	}
	listed, err = service.List(ctx, "Lobby", 1, 10)
	if err != nil || len(listed.Items) != 1 || !listed.Items[0].HasUnpublishedChanges {
		t.Fatalf("changed Layout was not reported as having unpublished changes: %#v err=%v", listed, err)
	}
	immutable, err := service.GetRevision(ctx, layout.ID, published.ID)
	if err != nil {
		t.Fatal(err)
	}
	if immutable.Document.Placements[0].Primitive.Text != "Welcome" {
		t.Fatal("published revision was mutated")
	}
	layout, err = service.Restore(ctx, layout.ID, published.ID, owner.User.ID, layout.DraftRevision)
	if err != nil {
		t.Fatal(err)
	}
	if layout.Draft.Placements[0].Primitive.Text != "Welcome" {
		t.Fatal("revision was not restored as draft")
	}
	videoA, videoB := uuid.New(), uuid.New()
	for _, videoID := range []uuid.UUID{videoA, videoB} {
		if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)VALUES($1,$2,'Video','video','video.mp4','video/mp4',$3,100,'ready',$4)`, videoID, organizationID, make([]byte, 32), owner.User.ID); err != nil {
			t.Fatal(err)
		}
	}
	document = layout.Draft
	document.Placements = append(document.Placements,
		Placement{ID: uuid.New(), Type: "asset", Name: "Video A", X: 0, Y: 500, Width: 400, Height: 300, Layer: 4, Opacity: 1, Visible: true, AssetID: &videoA, Playback: &Playback{Muted: true}},
		Placement{ID: uuid.New(), Type: "asset", Name: "Video B", X: 500, Y: 500, Width: 400, Height: 300, Layer: 5, Opacity: 1, Visible: true, AssetID: &videoB, Playback: &Playback{Muted: true}},
	)
	layout, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, layout.DraftRevision, document)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Publish(ctx, layout.ID, owner.User.ID, layout.DraftRevision); err == nil || !strings.Contains(err.Error(), "one visible video-capable") {
		t.Fatalf("expected video capability validation, got %v", err)
	}
}

// TestLayoutDataSourceBindingAndPlacementRules verifies that a text primitive may bind
// directly to a Data Source field, and that a Data Source can never be a widget placement.
func TestLayoutDataSourceBindingAndPlacementRules(t *testing.T) {
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
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE layouts, data_sources, widgets, assets, sessions, audit_logs, users, organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Binding Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool)
	var organizationID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	dataSourceID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by)VALUES($1,$2,'Lunch data','csv',jsonb_build_object('presentation','list'),$3)`, dataSourceID, organizationID, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	layout, err := service.Create(ctx, owner.User.ID, "Binding board", "", "landscape", 1920, 1080)
	if err != nil {
		t.Fatal(err)
	}
	rev := layout.DraftRevision

	// A widget placement that points at a Data Source id (not a widget asset) is rejected:
	// Data Sources can never be placed in a Layout as visual content. A failed draft save
	// rolls back, so the draft revision is unchanged for the next attempt.
	rejected := validTestDocument()
	rejected.Placements = append(rejected.Placements, Placement{ID: uuid.New(), Type: "widget", Name: "Bad", X: 0, Y: 0, Width: 200, Height: 100, Layer: 3, Opacity: 1, Visible: true, WidgetID: &dataSourceID})
	if _, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, rev, rejected); err == nil {
		t.Fatal("expected a Data Source placed as a widget to be rejected")
	}

	// A binding to an unknown Data Source is rejected.
	missing := validTestDocument()
	missing.Placements[0].Primitive.Binding = &Binding{DataSourceID: uuid.New(), Field: "title"}
	if _, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, rev, missing); err == nil {
		t.Fatal("expected a binding to an unknown Data Source to be rejected")
	}

	// A text primitive that binds directly to a CSV Data Source field publishes cleanly.
	document := validTestDocument()
	document.Placements[0].Primitive.Binding = &Binding{DataSourceID: dataSourceID, Field: "title"}
	layout, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, rev, document)
	if err != nil {
		t.Fatalf("save draft with data source binding: %v", err)
	}
	if _, err = service.Publish(ctx, layout.ID, owner.User.ID, layout.DraftRevision); err != nil {
		t.Fatalf("publish with data source binding: %v", err)
	}
}

// TestLayoutYouTubePlacementRules verifies the server-side YouTube constraints
// that mirror the shared Player Runtime: a visible YouTube placement must be
// at least 200x200 pixels, and a layout may contain only one visible YouTube
// placement. The runtime refuses the same layouts with typed errors, so
// authoring rejects them first.
func TestLayoutYouTubePlacementRules(t *testing.T) {
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
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE layouts, data_sources, widgets, assets, sessions, audit_logs, users, organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "YouTube Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool)
	var organizationID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	youtubeA, youtubeB := uuid.New(), uuid.New()
	for _, widgetID := range []uuid.UUID{youtubeA, youtubeB} {
		if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)VALUES($1,$2,'YouTube','widget','youtube.json','application/json',$3,100,'ready',$4)`, widgetID, organizationID, make([]byte, 32), owner.User.ID); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO widgets(asset_id,provider,config_version,configuration)VALUES($1,'youtube',1,'{}')`, widgetID); err != nil {
			t.Fatal(err)
		}
	}
	layout, err := service.Create(ctx, owner.User.ID, "YouTube board", "", "landscape", 1920, 1080)
	if err != nil {
		t.Fatal(err)
	}
	small := validTestDocument()
	small.Placements = append(small.Placements, Placement{ID: uuid.New(), Type: "widget", Name: "Trailer", X: 0, Y: 0, Width: 100, Height: 100, Layer: 2, Opacity: 1, Visible: true, WidgetID: &youtubeA})
	layout, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, layout.DraftRevision, small)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Publish(ctx, layout.ID, owner.User.ID, layout.DraftRevision); err == nil || !strings.Contains(err.Error(), "200 by 200") {
		t.Fatalf("expected youtube size validation, got %v", err)
	}
	sized := validTestDocument()
	sized.Placements = append(sized.Placements, Placement{ID: uuid.New(), Type: "widget", Name: "Trailer", X: 0, Y: 0, Width: 400, Height: 300, Layer: 2, Opacity: 1, Visible: true, WidgetID: &youtubeA})
	layout, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, layout.DraftRevision, sized)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Publish(ctx, layout.ID, owner.User.ID, layout.DraftRevision); err != nil {
		t.Fatalf("a 400x300 youtube placement should publish: %v", err)
	}
	pair := sized
	pair.Placements = append(pair.Placements, Placement{ID: uuid.New(), Type: "widget", Name: "Encore", X: 500, Y: 0, Width: 400, Height: 300, Layer: 3, Opacity: 1, Visible: true, WidgetID: &youtubeB})
	layout, err = service.SaveDraft(ctx, layout.ID, owner.User.ID, layout.DraftRevision+1, pair)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Publish(ctx, layout.ID, owner.User.ID, layout.DraftRevision); err == nil || !strings.Contains(err.Error(), "only one visible youtube") {
		t.Fatalf("expected single youtube validation, got %v", err)
	}
}
