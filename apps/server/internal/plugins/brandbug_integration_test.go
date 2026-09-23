package plugins

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestBrandBugLifecycleAndManifestTargeting(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	organizationID, userID, groupID := uuid.New(), uuid.New(), uuid.New()
	targetedScreen, otherScreen := uuid.New(), uuid.New()
	readyAsset, processingAsset := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Brand Bug Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','brand-owner','unused','owner',TRUE)`, userID); err != nil {
		t.Fatal(err)
	}
	for _, asset := range []struct {
		id     uuid.UUID
		status string
	}{{readyAsset, "ready"}, {processingAsset, "processing"}} {
		if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,
			sha256,original_size,processing_status,created_by)
			VALUES($1,$2,'Logo','image','logo.png','image/png',$3,1024,$4,$5)`,
			asset.id, organizationID, []byte("logo-digest"), asset.status, userID); err != nil {
			t.Fatal(err)
		}
	}
	for _, record := range []struct {
		id   uuid.UUID
		name string
	}{{targetedScreen, "Cafeteria"}, {otherScreen, "Lobby"}} {
		if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,
			device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
			VALUES($1,$2,$3,$4,'linux','Test','Display','Linux','1',1920,1080,1,'en-US','UTC')`,
			record.id, organizationID, uuid.NewString(), record.name); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id) VALUES($1)`, record.id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Sponsored screens',$3)`, groupID, organizationID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, groupID, targetedScreen, userID); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, nil)
	installPluginsForTest(t, pool, BrandBugID)

	// A logo that is not a ready image must be refused at save time rather than
	// becoming a manifest the Player cannot satisfy.
	unready := validBrandBug()
	unready.ImageAssetID = &processingAsset
	if _, err = service.CreateBrandBug(ctx, userID, unready); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected an unprocessed logo to be rejected, got %v", err)
	}
	missing := validBrandBug()
	absent := uuid.New()
	missing.ImageAssetID = &absent
	if _, err = service.CreateBrandBug(ctx, userID, missing); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected an unknown logo to be rejected, got %v", err)
	}

	logo := validBrandBug()
	logo.Name = "Sponsor logo"
	logo.ImageAssetID = &readyAsset
	logo.TargetScope = "sync_groups"
	logo.TargetIDs = []uuid.UUID{groupID}
	created, err := service.CreateBrandBug(ctx, userID, logo)
	if err != nil {
		t.Fatal(err)
	}
	if created.ImageAssetID == nil || *created.ImageAssetID != readyAsset {
		t.Fatalf("logo reference was not stored: %#v", created.ImageAssetID)
	}
	notice := validBrandBug()
	notice.Name = "Legal notice"
	notice.Corner = "bottom_left"
	if _, err = service.CreateBrandBug(ctx, userID, notice); err != nil {
		t.Fatal(err)
	}

	targeted, err := service.ManifestForScreen(ctx, targetedScreen)
	if err != nil || len(targeted) != 2 {
		t.Fatalf("targeted manifest: %#v %v", targeted, err)
	}
	corners := map[string]string{}
	for _, plugin := range targeted {
		config, ok := plugin.Config.(*ManifestBrandBugConfig)
		if !ok || plugin.Type != "brand_bug" || plugin.Version != 1 {
			t.Fatalf("unexpected plugin projection: %#v", plugin)
		}
		corners[config.Corner] = config.Name
		// Variant selection belongs to manifest assembly, not this package.
		if config.ImageVariantID != nil {
			t.Fatalf("plugins must not resolve media variants: %#v", config)
		}
	}
	if corners["top_right"] != "Sponsor logo" || corners["bottom_left"] != "Legal notice" {
		t.Fatalf("marks did not project to their corners: %#v", corners)
	}
	other, err := service.ManifestForScreen(ctx, otherScreen)
	if err != nil || len(other) != 1 {
		t.Fatalf("untargeted manifest: %#v %v", other, err)
	}

	// Clearing the logo leaves a text-only mark; disabling removes it entirely.
	update := created.BrandBugInput
	update.ImageAssetID = nil
	update.Text = "Presented by Example"
	if _, err = service.UpdateBrandBug(ctx, created.ID, userID, update); err != nil {
		t.Fatal(err)
	}
	reloaded, err := service.GetBrandBug(ctx, created.ID)
	if err != nil || reloaded.ImageAssetID != nil {
		t.Fatalf("logo was not cleared: %#v %v", reloaded.ImageAssetID, err)
	}
	update.Enabled = false
	if _, err = service.UpdateBrandBug(ctx, created.ID, userID, update); err != nil {
		t.Fatal(err)
	}
	targeted, err = service.ManifestForScreen(ctx, targetedScreen)
	if err != nil || len(targeted) != 1 {
		t.Fatalf("disabled mark leaked into the manifest: %#v %v", targeted, err)
	}

	// A soft-deleted logo must not take its instances with it.
	stillReferenced := validBrandBug()
	stillReferenced.Name = "Campaign badge"
	stillReferenced.Corner = "top_left"
	stillReferenced.ImageAssetID = &readyAsset
	badge, err := service.CreateBrandBug(ctx, userID, stillReferenced)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE assets SET deleted_at=now() WHERE id=$1`, readyAsset); err != nil {
		t.Fatal(err)
	}
	if _, err = service.GetBrandBug(ctx, badge.ID); err != nil {
		t.Fatalf("instance did not survive a soft-deleted logo: %v", err)
	}

	if err = service.DeleteBrandBug(ctx, badge.ID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.GetBrandBug(ctx, badge.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected the deleted instance to be gone, got %v", err)
	}
	if _, err = service.UpdateBrandBug(ctx, uuid.New(), userID, notice); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected an unknown instance update to be not found, got %v", err)
	}

	catalog, err := service.Catalog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var entry CatalogPlugin
	for _, item := range catalog.Items {
		if item.ID == "brand_bug" {
			entry = item
		}
	}
	// Two instances survive: the disabled logo mark and the text-only notice.
	if entry.Name == "" || entry.InstanceCount != 2 {
		t.Fatalf("brand bug catalog entry: %#v of %#v", entry, catalog.Items)
	}
}
