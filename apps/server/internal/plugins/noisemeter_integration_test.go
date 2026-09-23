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

func TestNoiseMeterLifecycleAndManifestTargeting(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Noise Meter Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','noise-owner','unused','owner',TRUE)`, userID); err != nil {
		t.Fatal(err)
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
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Noisy rooms',$3)`, groupID, organizationID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, groupID, targetedScreen, userID); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, nil)
	installPluginsForTest(t, pool, NoiseMeterID)

	invalid := validNoiseMeter()
	invalid.LoudLevel = invalid.WarningLevel
	if _, err = service.CreateNoiseMeter(ctx, userID, invalid); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected a single shared threshold to be rejected, got %v", err)
	}
	unknownTarget := validNoiseMeter()
	unknownTarget.TargetScope = "screens"
	unknownTarget.TargetIDs = []uuid.UUID{uuid.New()}
	if _, err = service.CreateNoiseMeter(ctx, userID, unknownTarget); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected an unknown target to be rejected, got %v", err)
	}

	grouped := validNoiseMeter()
	grouped.Name = "Cafeteria noise"
	grouped.TargetScope = "sync_groups"
	grouped.TargetIDs = []uuid.UUID{groupID}
	grouped.Sensitivity = 140
	grouped.DisplayMode = "push"
	created, err := service.CreateNoiseMeter(ctx, userID, grouped)
	if err != nil {
		t.Fatal(err)
	}
	if created.Sensitivity != 140 || created.DisplayMode != "push" || len(created.TargetIDs) != 1 {
		t.Fatalf("instance was not stored as configured: %#v", created)
	}

	targeted, err := service.ManifestForScreen(ctx, targetedScreen)
	if err != nil || len(targeted) != 1 {
		t.Fatalf("targeted manifest: %#v %v", targeted, err)
	}
	config, ok := targeted[0].Config.(ManifestNoiseMeterConfig)
	if !ok || targeted[0].Type != "noise_meter" || targeted[0].Version != 1 {
		t.Fatalf("unexpected plugin projection: %#v", targeted[0])
	}
	if config.WarningLevel != 60 || config.LoudLevel != 80 || config.Sensitivity != 140 ||
		config.TriggerHoldMS != 1000 || config.ClearHoldMS != 3000 || config.DisplayMode != "push" {
		t.Fatalf("projected configuration: %#v", config)
	}
	other, err := service.ManifestForScreen(ctx, otherScreen)
	if err != nil || len(other) != 0 {
		t.Fatalf("untargeted screen received a meter: %#v %v", other, err)
	}

	// One screen has one microphone, so two applicable instances resolve to one
	// deterministic meter rather than two meters competing for the same input.
	everywhere := validNoiseMeter()
	everywhere.Name = "All screens"
	if _, err = service.CreateNoiseMeter(ctx, userID, everywhere); err != nil {
		t.Fatal(err)
	}
	overlapping, err := service.ManifestForScreen(ctx, targetedScreen)
	if err != nil || len(overlapping) != 1 {
		t.Fatalf("overlapping instances produced %#v %v", overlapping, err)
	}
	first, err := service.ManifestForScreen(ctx, targetedScreen)
	if err != nil || first[0].ID != overlapping[0].ID {
		t.Fatalf("overlap resolution is not deterministic: %v then %v", overlapping[0].ID, first[0].ID)
	}

	stored, err := service.GetNoiseMeter(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	update := stored.NoiseMeterInput
	update.Enabled = false
	if _, err = service.UpdateNoiseMeter(ctx, created.ID, userID, update); err != nil {
		t.Fatal(err)
	}
	afterDisable, err := service.ManifestForScreen(ctx, targetedScreen)
	if err != nil || len(afterDisable) != 1 || afterDisable[0].ID == created.ID {
		t.Fatalf("disabled instance leaked into the manifest: %#v %v", afterDisable, err)
	}

	listed, err := service.ListNoiseMeters(ctx)
	if err != nil || len(listed) != 2 {
		t.Fatalf("listing: %#v %v", listed, err)
	}

	// Every create, update, and delete has to revise the manifest for the
	// screens that could be showing the meter.
	var revisions int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM screen_manifest_state WHERE manifest_version >= 3`).Scan(&revisions); err != nil {
		t.Fatal(err)
	}
	if revisions != 2 {
		t.Fatalf("expected both screen manifests to be revised, got %d", revisions)
	}

	catalog, err := service.Catalog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var entry CatalogPlugin
	for _, item := range catalog.Items {
		if item.ID == "noise_meter" {
			entry = item
		}
	}
	if entry.Name == "" || entry.InstanceCount != 2 || !entry.Active || !entry.Configured || !entry.Installed {
		t.Fatalf("noise meter catalog entry: %#v of %#v", entry, catalog.Items)
	}

	if err = service.DeleteNoiseMeter(ctx, created.ID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.GetNoiseMeter(ctx, created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected the deleted instance to be gone, got %v", err)
	}
	if _, err = service.UpdateNoiseMeter(ctx, uuid.New(), userID, validNoiseMeter()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected an unknown instance update to be not found, got %v", err)
	}
	if err = service.DeleteNoiseMeter(ctx, uuid.New(), userID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected an unknown instance delete to be not found, got %v", err)
	}
}
