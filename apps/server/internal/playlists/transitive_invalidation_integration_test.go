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
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

func TestTransitiveAssetChangeInvalidatesNestedLayoutsGroupsAndSchedules(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE presentation_overrides,takeover_screen_states,takeover_targets,takeovers,schedule_targets,schedules,screen_group_playlist_assignments,screen_group_memberships,screen_groups,screen_manifest_state,screen_playlist_assignments,playlist_items,playlists,layout_revision_dependencies,layout_draft_dependencies,layout_revisions,layouts,asset_variants,assets,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Transitive Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var organizationID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	screens := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	for index, screenID := range screens {
		if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,$4,'linux','Test','Display','Linux','1',1920,1080,1,'en-US','UTC')`, screenID, organizationID, uuid.NewString(), "Screen "+string(rune('1'+index))); err != nil {
			t.Fatal(err)
		}
	}
	assetID, variantID := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by) VALUES($1,$2,'Nested image','image','nested.png','image/png',$3,100,1920,1080,'ready',$4)`, assetID, organizationID, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible) VALUES($1,$2,'original','local','originals/nested','image/png',100,$3,1920,1080,TRUE)`, variantID, assetID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, &testNotifier{})
	nested, err := service.Create(ctx, owner.User.ID, "Nested playlist", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(10_000)
	if _, err = service.AddItem(ctx, nested.ID, owner.User.ID, ItemInput{AssetID: assetID, DurationMS: &duration}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, ctx, service, nested.ID, owner.User.ID)
	layoutService := layouts.NewService(pool)
	layoutService.SetManifestInvalidator(service)
	layout, err := layoutService.Create(ctx, owner.User.ID, "Nested layout", "", "landscape", 1920, 1080)
	if err != nil {
		t.Fatal(err)
	}
	playlistPlacement := uuid.New()
	document := layouts.Document{
		SchemaVersion: 2,
		Canvas:        layouts.Canvas{Width: 1920, Height: 1080, Orientation: "landscape", BackgroundColor: "#0E141B", SafeAreaPercent: 5},
		Placements:    []layouts.Placement{{ID: playlistPlacement, Type: "playlistZone", Name: "Nested zone", X: 0, Y: 0, Width: 1920, Height: 1080, Layer: 1, Opacity: 1, Visible: true, PlaylistID: &nested.ID}},
	}
	layout, err = layoutService.SaveDraft(ctx, layout.ID, owner.User.ID, layout.DraftRevision, document)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = layoutService.Publish(ctx, layout.ID, owner.User.ID, layout.DraftRevision); err != nil {
		t.Fatal(err)
	}
	root, err := service.Create(ctx, owner.User.ID, "Root playlist", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	layoutDuration := int64(60_000)
	if _, err = service.AddItem(ctx, root.ID, owner.User.ID, ItemInput{LayoutID: &layout.ID, DurationMS: &layoutDuration}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, ctx, service, root.ID, owner.User.ID)
	if _, err = service.Assign(ctx, screens[0], root.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	groupID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Nested group',$3)`, groupID, organizationID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3),($1,$4,$3)`, groupID, screens[1], owner.User.ID, screens[2]); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_playlist_assignments(screen_group_id,playlist_id,assigned_by) VALUES($1,$2,$3)`, groupID, root.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	scheduleID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO schedules(id,organization_id,name,playlist_id,type,timezone,priority,enabled,one_time_start,one_time_end,created_by) VALUES($1,$2,'Nested schedule',$3,'one_time','UTC',1,TRUE,$4,$5,$6)`, scheduleID, organizationID, root.ID, now.Add(-time.Hour), now.Add(time.Hour), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_id) VALUES($1,'screen',$2)`, scheduleID, screens[2]); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id) SELECT id FROM screens ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	manifest, _, err := service.BuildManifest(ctx, screens[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Layouts) == 0 || len(manifest.Playlists) == 0 {
		t.Fatalf("nested composition was not projected: layouts=%d playlists=%d", len(manifest.Layouts), len(manifest.Playlists))
	}
	before := map[uuid.UUID]int64{}
	for _, screenID := range screens {
		var version int64
		if err = pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screenID).Scan(&version); err != nil {
			t.Fatal(err)
		}
		before[screenID] = version
	}
	storePreview := func() {
		t.Helper()
		if _, err = pool.Exec(ctx, `UPDATE layouts SET preview_image=$2,preview_content_type='image/jpeg',preview_width=960,preview_height=540,preview_updated_at=now(),preview_capture_version=$3 WHERE id=$1`, layout.ID, []byte{1}, layouts.LayoutPreviewCaptureVersion); err != nil {
			t.Fatal(err)
		}
	}
	assertPreviewInvalidated := func(change string) {
		t.Helper()
		if _, previewErr := layoutService.PreviewImage(ctx, layout.ID); !errors.Is(previewErr, layouts.ErrNotFound) {
			t.Fatalf("%s did not invalidate the referenced Layout thumbnail: %v", change, previewErr)
		}
	}
	storePreview()
	if err = service.AssetChanged(ctx, assetID, "nested.asset.changed"); err != nil {
		t.Fatal(err)
	}
	assertPreviewInvalidated("asset change through a nested Playlist")
	for _, screenID := range screens {
		var after int64
		if err = pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screenID).Scan(&after); err != nil {
			t.Fatal(err)
		}
		if after <= before[screenID] {
			t.Fatalf("screen %s did not receive transitive invalidation: before=%d after=%d", screenID, before[screenID], after)
		}
	}

	// Widget dependencies use their own dependency type even though Widget IDs
	// are also asset IDs. Updating the Widget must clear its Layout thumbnail.
	widgetID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by) VALUES($1,$2,'Widget','widget','widget.json','application/json',$3,10,'ready',$4)`, widgetID, organizationID, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO widgets(asset_id,provider,configuration) VALUES($1,'clock','{}'::jsonb)`, widgetID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO layout_draft_dependencies(layout_id,dependency_type,dependency_id) VALUES($1,'widget',$2)`, layout.ID, widgetID); err != nil {
		t.Fatal(err)
	}
	storePreview()
	mediaService := media.NewService(pool, nil, media.Config{})
	mediaService.SetAssetInvalidator(service)
	if _, err = mediaService.UpdateWidget(ctx, widgetID, owner.User.ID, media.WidgetInput{
		Provider:      "clock",
		Name:          "Updated Widget",
		Configuration: []byte(`{"timezone":"UTC","format":"24","showSeconds":true,"foregroundColor":"#ffffff","backgroundColor":"#111111"}`),
	}); err != nil {
		t.Fatal(err)
	}
	assertPreviewInvalidated("Widget update")

	// Playlist publication uses the same dependency traversal as its normal
	// manifest invalidation path.
	storePreview()
	duration = 12_000
	if _, err = service.AddItem(ctx, nested.ID, owner.User.ID, ItemInput{AssetID: assetID, DurationMS: &duration}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, ctx, service, nested.ID, owner.User.ID)
	assertPreviewInvalidated("Playlist update")

	dataSourceID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by) VALUES($1,$2,'Schedule data','csv','{}'::jsonb,$3)`, dataSourceID, organizationID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO layout_draft_dependencies(layout_id,dependency_type,dependency_id) VALUES($1,'data_source',$2)`, layout.ID, dataSourceID); err != nil {
		t.Fatal(err)
	}
	storePreview()
	if _, err = mediaService.UpdateDataSource(ctx, dataSourceID, owner.User.ID, media.DataSourceInput{
		Provider:      "csv",
		Name:          "Updated schedule data",
		Configuration: []byte(`{"uploaded":true,"uploadedContent":"title\nLunch\n","presentation":"list","maxItems":10,"fields":{"title":true},"sort":"source","mapping":{"title":"title"},"refreshIntervalSeconds":3600,"stalenessLimitHours":168,"emptyState":"No items"}`),
	}); err != nil {
		t.Fatal(err)
	}
	assertPreviewInvalidated("Data Source update")
	afterLayout, err := layoutService.Get(ctx, layout.ID)
	if err != nil {
		t.Fatal(err)
	}
	publishedRevisionChanged := (afterLayout.PublishedRevision == nil) != (layout.PublishedRevision == nil)
	if !publishedRevisionChanged && afterLayout.PublishedRevision != nil {
		publishedRevisionChanged = *afterLayout.PublishedRevision != *layout.PublishedRevision
	}
	if afterLayout.DraftRevision != layout.DraftRevision || publishedRevisionChanged {
		t.Fatalf("dependency updates changed Layout revisions: before draft=%d published=%v, after draft=%d published=%v", layout.DraftRevision, layout.PublishedRevision, afterLayout.DraftRevision, afterLayout.PublishedRevision)
	}
}
