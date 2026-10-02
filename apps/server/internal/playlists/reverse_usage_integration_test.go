package playlists

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

// TestReverseUsageReachesScreens covers the two reverse-dependency edges Studio needs to walk a
// Data Source forward to the screens actually displaying it: an asset reports the playlists that
// contain it, and a playlist reports the screens and schedules that play it. Both edges are
// resolved from stored records and the injected catalog, so they need a real database.
func TestReverseUsageReachesScreens(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE schedules,screen_group_playlist_assignments,screen_group_memberships,screen_groups,screen_player_status,screen_manifest_state,screen_playlist_assignments,playlist_items,playlists,media_jobs,upload_sessions,asset_variants,assets,device_pairing_sessions,device_credentials,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Usage Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}

	// One screen assigned directly, one reaching the same playlist through a synchronized group.
	directScreen, groupScreen := uuid.New(), uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$3,$4,'Cafeteria','android-tv','Google','ADT-3','14','0.4.0',1920,1080,2,'en-US','UTC'),($2,$3,$5,'Library','android-tv','Google','ADT-3','14','0.4.0',1920,1080,2,'en-US','UTC')`, directScreen, groupScreen, org, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	assetID := uuid.New()
	for _, screen := range []uuid.UUID{directScreen, groupScreen} {
		(&capabilityFixture{ctx: ctx, pool: pool, screen: screen}).reportV13Capabilities(t)
	}
	_, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,duration_seconds,processing_status,created_by)VALUES($1,$2,'Welcome','image','welcome.png','image/png',$3,100,1920,1080,NULL,'ready',$4)`, assetID, org, make([]byte, 32), owner.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible)VALUES($1,$2,'original','local','originals/welcome','image/png',100,$3,1920,1080,TRUE)`, uuid.New(), assetID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}

	// A declarative Widget reads two Data Sources from separate repeating-group rows.
	// Separate repeating-group rows catch traversals that stop after the first item.
	sourceID, secondSourceID, widgetID := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by)VALUES($1,$3,'Lunch rows','csv','{}'::jsonb,$4),($2,$3,'Allergen notes','csv','{}'::jsonb,$4)`, sourceID, secondSourceID, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)VALUES($1,$2,'Today''s Lunch','widget','','application/json',$3,0,'ready',$4)`, widgetID, org, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO widgets(asset_id,provider,config_version,configuration)VALUES($1,'dual-source-banner',1,jsonb_build_object('heading','Lunch','sourceRows',jsonb_build_array(jsonb_build_object('source',$2::text),jsonb_build_object('source',$3::text))))`, widgetID, sourceID.String(), secondSourceID.String()); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, &testNotifier{})
	service.SetContentDefinitions(customCatalog(t))
	playlist, err := service.Create(ctx, owner.User.ID, "Cafeteria loop", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(10_000)
	if _, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: assetID, DurationMS: &duration}); err != nil {
		t.Fatal(err)
	}
	if _, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: widgetID, DurationMS: &duration}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, ctx, service, playlist.ID, owner.User.ID)

	// An unrelated playlist must not appear in the asset's usage.
	other, err := service.Create(ctx, owner.User.ID, "Unrelated", "", "static")
	if err != nil {
		t.Fatal(err)
	}

	if _, err = service.Assign(ctx, directScreen, playlist.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	groupID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by)VALUES($1,$2,'North wing',$3)`, groupID, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id)VALUES($1,$2)`, groupID, groupScreen); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_playlist_assignments(screen_group_id,playlist_id,assigned_by)VALUES($1,$2,$3)`, groupID, playlist.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO schedules(id,organization_id,name,playlist_id,type,timezone,priority,start_date,daily_start,daily_end,days_of_week,created_by)VALUES($1,$2,'Lunch hour',$3,'weekly','UTC',10,CURRENT_DATE,'11:00','13:00','{1,2,3,4,5}',$4)`, uuid.New(), org, playlist.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	// Asset -> playlists, by identity rather than a bare count.
	asset, err := media.NewService(pool, nil, media.Config{}).GetAsset(ctx, assetID)
	if err != nil {
		t.Fatal(err)
	}
	if asset.PlaylistUsage != 1 {
		t.Fatalf("playlistUsage=%d, want 1", asset.PlaylistUsage)
	}
	if len(asset.PlaylistsUsing) != 1 || asset.PlaylistsUsing[0].ID != playlist.ID || asset.PlaylistsUsing[0].Name != "Cafeteria loop" {
		t.Fatalf("playlistsUsing=%#v", asset.PlaylistsUsing)
	}

	// Playlist -> screens and schedules, reaching a screen both directly and through a group.
	detail, err := service.Get(ctx, playlist.ID)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, screen := range detail.Usage.Screens {
		names[screen.Name] = true
	}
	if len(detail.Usage.Screens) != 2 || !names["Cafeteria"] || !names["Library"] {
		t.Fatalf("usage.screens=%#v", detail.Usage.Screens)
	}
	if len(detail.Usage.Schedules) != 1 || detail.Usage.Schedules[0].Name != "Lunch hour" {
		t.Fatalf("usage.schedules=%#v", detail.Usage.Schedules)
	}

	// The playlist reaches both Data Sources its Widget reads, without Studio having to open each
	// item. This is the leg that used to stop at the Widget list.
	reached := map[uuid.UUID]bool{}
	for _, source := range detail.DataSourceIDs {
		reached[source] = true
	}
	if len(detail.DataSourceIDs) != 2 || !reached[sourceID] || !reached[secondSourceID] {
		t.Fatalf("dataSourceIds=%v, want %s and %s", detail.DataSourceIDs, sourceID, secondSourceID)
	}

	// Both nested selections protect their sources from deletion using the same catalog.
	mediaService := media.NewService(pool, nil, media.Config{})
	mediaService.SetContentDefinitions(customCatalog(t))
	for _, source := range []uuid.UUID{sourceID, secondSourceID} {
		var dependencyError *media.DependencyError
		if err = mediaService.DeleteDataSource(ctx, source, owner.User.ID); !errors.As(err, &dependencyError) {
			t.Fatalf("delete nested source %s: got %v, want dependency error", source, err)
		}
		if len(dependencyError.UsedBy) != 1 || dependencyError.UsedBy[0] != "widget Today's Lunch" {
			t.Fatalf("nested source consumers = %v", dependencyError.UsedBy)
		}
	}

	manifest, _, err := service.BuildManifest(ctx, directScreen)
	if err != nil {
		t.Fatal(err)
	}
	projectedSources := map[uuid.UUID]bool{}
	for _, source := range manifest.DataSources {
		projectedSources[source.ID] = true
	}
	if len(projectedSources) != 2 || !projectedSources[sourceID] || !projectedSources[secondSourceID] {
		t.Fatalf("manifest Data Sources = %v", projectedSources)
	}

	// A playlist nothing plays reports empty arrays, never null, so Studio can render it directly.
	empty, err := service.Get(ctx, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	if empty.DataSourceIDs == nil || len(empty.DataSourceIDs) != 0 {
		t.Fatalf("unused playlist dataSourceIds=%v", empty.DataSourceIDs)
	}
	if empty.Usage.Screens == nil || empty.Usage.Schedules == nil {
		t.Fatalf("unused playlist usage=%#v", empty.Usage)
	}
	if len(empty.Usage.Screens) != 0 || len(empty.Usage.Schedules) != 0 {
		t.Fatalf("unused playlist reported usage=%#v", empty.Usage)
	}
}
