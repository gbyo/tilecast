package playlists

import (
	"context"
	"encoding/json"
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
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

type testNotifier struct{ versions []int64 }

func (n *testNotifier) ManifestChanged(_ uuid.UUID, version int64) {
	n.versions = append(n.versions, version)
}

func publishDraftForTest(t *testing.T, ctx context.Context, service *Service, playlistID, userID uuid.UUID) {
	t.Helper()
	snapshot, err := service.DraftSnapshot(ctx, playlistID)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := service.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	published, err := service.PublishSnapshotTx(ctx, tx, playlistID, snapshot.Document, snapshot.WorkingRevision, userID)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	service.NotifyPublication(published.Changes)
}

func TestPlaylistAssignmentManifestLifecycle(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE screen_player_status,screen_manifest_state,screen_playlist_assignments,playlist_items,playlists,media_jobs,upload_sessions,asset_variants,assets,device_pairing_sessions,device_credentials,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Playlist Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	screenID := uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Lobby','android-tv','Google','ADT-3','14','0.4.0',1920,1080,2,'en-US','UTC')`, screenID, org, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	imageID, videoID := uuid.New(), uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,duration_seconds,processing_status,created_by)VALUES($1,$3,'Welcome','image','welcome.png','image/png',$4,100,1920,1080,NULL,'ready',$5),($2,$3,'Announcement','video','announcement.mp4','video/mp4',$4,1000,1920,1080,12.5,'ready',$5)`, imageID, videoID, org, make([]byte, 32), owner.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	imageVariant, videoVariant := uuid.New(), uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,duration_seconds,player_compatible)VALUES($1,$3,'original','local',$5,'image/png',100,$7,1920,1080,NULL,TRUE),($2,$4,'playback','local',$6,'video/mp4',1000,$7,1920,1080,12.5,TRUE)`, imageVariant, videoVariant, imageID, videoID, "originals/image", "variants/video", make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	notifier := &testNotifier{}
	service := NewService(pool, notifier)
	tagPlaylist, err := service.Create(ctx, owner.User.ID, "Tagged announcements", "", "tag")
	if err != nil {
		t.Fatal(err)
	}
	if tagPlaylist.SourceType != "tag" || tagPlaylist.TagRule == nil || len(tagPlaylist.TagRule.Tags) != 0 {
		t.Fatalf("new tag playlist=%#v", tagPlaylist)
	}
	playlist, err := service.Create(ctx, owner.User.ID, "Morning announcements", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	// An omitted image duration resolves to the organization default
	// (10 seconds when the setting is absent) instead of being rejected.
	playlist, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: imageID})
	if err != nil {
		t.Fatal(err)
	}
	if len(playlist.Items) != 1 || playlist.Items[0].DurationMS == nil || *playlist.Items[0].DurationMS != 10_000 {
		t.Fatalf("omitted image duration did not fall back to the default: %#v", playlist)
	}
	zero := int64(0)
	if _, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: imageID, DurationMS: &zero}); err == nil {
		t.Fatal("image with zero duration was accepted")
	}
	duration := int64(10_000)
	playlist, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: videoID})
	if err != nil {
		t.Fatal(err)
	}
	if len(playlist.Items) != 2 || playlist.DraftRevision != 3 || playlist.Revision != 1 || !playlist.HasUnpublishedChanges {
		t.Fatalf("playlist=%#v", playlist)
	}
	playlist, err = service.Reorder(ctx, playlist.ID, owner.User.ID, []uuid.UUID{playlist.Items[1].ID, playlist.Items[0].ID})
	if err != nil || playlist.Items[0].AssetID != videoID {
		t.Fatalf("reorder: %#v %v", playlist, err)
	}
	publishDraftForTest(t, ctx, service, playlist.ID, owner.User.ID)
	playlist, err = service.GetDraft(ctx, playlist.ID)
	if err != nil || playlist.HasUnpublishedChanges {
		t.Fatalf("published playlist draft state=%#v err=%v", playlist, err)
	}
	assignment, err := service.Assign(ctx, screenID, playlist.ID, owner.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	manifest, etag, err := service.BuildManifest(ctx, screenID)
	if err != nil {
		t.Fatal(err)
	}
	same, sameETag, err := service.BuildManifest(ctx, screenID)
	if err != nil || same.ManifestVersion != manifest.ManifestVersion || sameETag != etag {
		t.Fatal("manifest read changed version or ETag")
	}
	if manifest.SchemaVersion != 11 || manifest.DirectFallbackPlaylist == nil || len(manifest.DirectFallbackPlaylist.Items) != 2 || len(manifest.Assets) != 2 {
		t.Fatalf("manifest=%#v", manifest)
	}
	tagID := uuid.New()
	availableFrom := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	expiresAt := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	if _, err = pool.Exec(ctx, `INSERT INTO content_tags(id,organization_id,name,color,created_by) VALUES($1,$2,'Lobby','#2563eb',$3)`, tagID, org, owner.User.ID); err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO content_asset_tags(asset_id,tag_id) VALUES($1,$2)`, imageID, tagID)
	}
	if err == nil {
		_, err = pool.Exec(ctx, `UPDATE assets SET available_from=$2,expires_at=$3 WHERE id=$1`, imageID, availableFrom, expiresAt)
	}
	if err != nil {
		t.Fatal(err)
	}
	playlist, err = service.SetTagRule(ctx, playlist.ID, owner.User.ID, TagRuleInput{Enabled: true, Match: "any", ImageDurationMS: 15000, TagIDs: []uuid.UUID{tagID}})
	if err != nil || playlist.SourceType != "tag" || playlist.TagRule == nil || len(playlist.Items) != 1 || !playlist.Items[0].Dynamic || *playlist.Items[0].DurationMS != 15000 {
		t.Fatalf("tag playlist=%#v err=%v", playlist, err)
	}
	publishDraftForTest(t, ctx, service, playlist.ID, owner.User.ID)
	tagManifest, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || tagManifest.DirectFallbackPlaylist == nil || len(tagManifest.DirectFallbackPlaylist.Items) != 1 || tagManifest.DirectFallbackPlaylist.Items[0].AvailableFrom == nil || tagManifest.DirectFallbackPlaylist.Items[0].ExpiresAt == nil {
		t.Fatalf("tag manifest=%#v err=%v", tagManifest, err)
	}
	if _, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: imageID, DurationMS: &duration}); !errors.Is(err, ErrConflict) {
		t.Fatalf("tag playlist accepted a manual item: %v", err)
	}
	playlist, err = service.SetTagRule(ctx, playlist.ID, owner.User.ID, TagRuleInput{Enabled: false, Match: "any", ImageDurationMS: 10000})
	if err != nil || playlist.SourceType != "static" || len(playlist.Items) != 2 {
		t.Fatalf("manual playlist was not restored: %#v err=%v", playlist, err)
	}
	publishDraftForTest(t, ctx, service, playlist.ID, owner.User.ID)
	playlist, err = service.UpdateItem(ctx, playlist.ID, playlist.Items[0].ID, owner.User.ID, ItemInput{AssetID: videoID, Transition: "crossfade"})
	if err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, ctx, service, playlist.ID, owner.User.ID)
	legacyCrossfade, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || legacyCrossfade.SchemaVersion != 11 || legacyCrossfade.DirectFallbackPlaylist.Items[0].Transition != "fade" {
		t.Fatalf("legacy crossfade projection=%#v err=%v", legacyCrossfade, err)
	}
	crossfadeCapabilities, _ := json.Marshal(NativePresentationCapabilities)
	if _, err = pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id,player_version_code,presentation_schema_versions,native_presentation_capabilities,web_runtime_version,web_bundle_limit_bytes)VALUES($1,$2,'{1}',$3,1,20971520) ON CONFLICT(screen_id)DO UPDATE SET player_version_code=EXCLUDED.player_version_code,presentation_schema_versions=EXCLUDED.presentation_schema_versions,native_presentation_capabilities=EXCLUDED.native_presentation_capabilities,web_runtime_version=EXCLUDED.web_runtime_version,web_bundle_limit_bytes=EXCLUDED.web_bundle_limit_bytes`, screenID, crossfadePlayerVersionCode, crossfadeCapabilities); err != nil {
		t.Fatal(err)
	}
	crossfadeManifest, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || crossfadeManifest.SchemaVersion != 14 || crossfadeManifest.DirectFallbackPlaylist.Items[0].Transition != "crossfade" {
		t.Fatalf("v14 crossfade projection=%#v err=%v", crossfadeManifest, err)
	}
	playlist, err = service.UpdateItem(ctx, playlist.ID, playlist.Items[0].ID, owner.User.ID, ItemInput{AssetID: videoID})
	if err != nil {
		t.Fatal(err)
	}
	// Editing the working draft does not invalidate the assigned screen. The
	// manifest changes only after the exact draft is published.
	unchanged, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || unchanged.ManifestVersion != crossfadeManifest.ManifestVersion {
		t.Fatalf("draft edit changed manifest: before=%d after=%d err=%v", crossfadeManifest.ManifestVersion, unchanged.ManifestVersion, err)
	}
	publishDraftForTest(t, ctx, service, playlist.ID, owner.User.ID)
	if _, err = pool.Exec(ctx, `UPDATE screen_player_status SET player_version_code=NULL,presentation_schema_versions='{}',native_presentation_capabilities='{}',web_runtime_version=0,web_bundle_limit_bytes=0 WHERE screen_id=$1`, screenID); err != nil {
		t.Fatal(err)
	}
	takeoverID := uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO takeovers(id,organization_id,name,playlist_id,status,activated_by,activated_at,expires_at)VALUES($1,$2,'Test takeover',$3,'active',$4,now(),now()+interval '1 hour')`, takeoverID, org, playlist.ID, owner.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO takeover_targets(takeover_id,target_type,screen_id)VALUES($1,'screen',$2)`, takeoverID, screenID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO takeover_screen_states(takeover_id,screen_id,manifest_version,state)VALUES($1,$2,$3,'pending')`, takeoverID, screenID, manifest.ManifestVersion); err != nil {
		t.Fatal(err)
	}
	takeoverManifest, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || takeoverManifest.Takeover == nil || takeoverManifest.Takeover.ID != takeoverID || takeoverManifest.Takeover.PlaylistID != playlist.ID {
		t.Fatalf("takeover manifest=%#v err=%v", takeoverManifest.Takeover, err)
	}
	if takeoverManifest.LegacyTakeover == nil || takeoverManifest.LegacyTakeover.ID != takeoverID || takeoverManifest.LegacyTakeover.PlaylistID != playlist.ID {
		t.Fatalf("legacy takeover manifest=%#v", takeoverManifest.LegacyTakeover)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM takeovers WHERE id=$1`, takeoverID); err != nil {
		t.Fatal(err)
	}
	scheduler := scheduling.NewService(pool, notifier, scheduling.Limits{MaxSchedules: 1000, MaxTargetsPerSchedule: 250, MaxGroupsPerScreen: 50, PrefetchDays: 14, ActivationGraceSeconds: 30, ClockSkewWarningSeconds: 300})
	service.SetScheduling(scheduler)
	group, err := scheduler.CreateGroup(ctx, owner.User.ID, "Lobby screens", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = scheduler.AddScreen(ctx, group.ID, screenID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	otherGroup, err := scheduler.CreateGroup(ctx, owner.User.ID, "Other screens", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = scheduler.AddScreen(ctx, otherGroup.ID, screenID, owner.User.ID); !errors.Is(err, scheduling.ErrConflict) {
		t.Fatalf("screen joined a second sync group: %v", err)
	}
	start, end := time.Now().Add(-time.Hour), time.Now().Add(time.Hour)
	scheduled, err := scheduler.Create(ctx, owner.User.ID, scheduling.Input{Name: "Special event", PlaylistID: playlist.ID, Type: scheduling.OneTime, Timezone: "America/New_York", Priority: 500, Enabled: true, OneTimeStart: &start, OneTimeEnd: &end, Targets: []scheduling.Target{{Type: "screen", ID: screenID}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(scheduled.Targets) != 1 || scheduled.Targets[0].Type != "group" || scheduled.Targets[0].ID != group.ID {
		t.Fatalf("grouped screen target was not normalized: %#v", scheduled.Targets)
	}
	scheduledManifest, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || len(scheduledManifest.Schedules) != 1 || len(scheduledManifest.Playlists) != 1 || scheduledManifest.SyncGroup == nil || scheduledManifest.SyncGroup.ID != group.ID {
		t.Fatalf("scheduled manifest=%#v %v", scheduledManifest, err)
	}
	updatedInput := ItemInput{AssetID: videoID, DeliveryPolicy: "stream"}
	playlist, err = service.UpdateItem(ctx, playlist.ID, playlist.Items[0].ID, owner.User.ID, updatedInput)
	if err != nil {
		t.Fatal(err)
	}
	changed, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || changed.ManifestVersion <= manifest.ManifestVersion {
		t.Fatal("playlist publication did not advance manifest")
	}
	active := changed.ManifestVersion
	status := PlayerStatus{ActiveManifestVersion: &active, PlaybackState: "playing"}
	if err = service.ReportStatus(ctx, screenID, status); err != nil {
		t.Fatal(err)
	}
	assignment, err = service.Assignment(ctx, screenID)
	if err != nil || assignment.SynchronizationStatus != "current" {
		t.Fatalf("assignment=%#v %v", assignment, err)
	}
	if err = service.Delete(ctx, playlist.ID, owner.User.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("assigned playlist deletion=%v", err)
	}
	noAssignment, err := service.Unassign(ctx, screenID, owner.User.ID)
	if err != nil || noAssignment.PlaylistID != nil {
		t.Fatalf("unassign=%#v %v", noAssignment, err)
	}
	if err = scheduler.Delete(ctx, scheduled.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	empty, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || empty.DirectFallbackPlaylist != nil {
		t.Fatalf("empty manifest=%#v %v", empty, err)
	}
	websiteID := uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)VALUES($1,$2,'Status website','widget','','application/vnd.tilecast.widget+json',''::bytea,0,'ready',$3)`, websiteID, org, owner.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO website_assets(asset_id,url,display_url,allowed_hosts,failure_behavior,fallback_image_asset_id)VALUES($1,'https://example.com/status','https://example.com/status',ARRAY['example.com'],'fallback_image',$2)`, websiteID, imageID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO widgets(asset_id,provider,configuration)VALUES($1,'website',jsonb_build_object('url','https://example.com/status','displayUrl','https://example.com/status','allowedHosts',jsonb_build_array('example.com'),'javascriptEnabled',true,'domStorageEnabled',true,'cookiePolicy','first_party','reloadPolicy','on_each_activation','loadTimeoutSeconds',20,'zoomPercent',100,'scrollX',0,'scrollY',0,'customUserAgent','','backgroundColor','#0E141B','failureBehavior','fallback_image','fallbackImageAssetId',$2::text))`, websiteID, imageID)
	if err != nil {
		t.Fatal(err)
	}
	webPlaylist, err := service.Create(ctx, owner.User.ID, "Web status", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	webDuration := int64(30000)
	webPlaylist, err = service.AddItem(ctx, webPlaylist.ID, owner.User.ID, ItemInput{AssetID: websiteID, DurationMS: &webDuration, DeliveryPolicy: "stream"})
	if err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, ctx, service, webPlaylist.ID, owner.User.ID)
	if _, err = service.Assign(ctx, screenID, webPlaylist.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	webManifest, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || webManifest.SchemaVersion != 11 || len(webManifest.Widgets) != 1 || webManifest.Widgets[0].Provider != "website" || len(webManifest.Assets) != 1 {
		t.Fatalf("website manifest=%#v %v", webManifest, err)
	}
	// Calendar is a Data Source; an Agenda Widget consumes it and is the playlist item.
	calendarID := uuid.New()
	calendarConfiguration := `{"calendars":[{"name":"School","url":"https://private.example/calendar.ics"}],"displayMode":"upcoming","maxEvents":10,"fields":{"title":true,"startTime":true,"endTime":false,"date":true,"location":true,"descriptionExcerpt":false},"timezone":"UTC","refreshIntervalSeconds":900,"stalenessLimitHours":168,"emptyState":"No events"}`
	_, err = pool.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by)VALUES($1,$2,'School calendar','calendar',$3::jsonb,$4)`, calendarID, org, calendarConfiguration, owner.User.ID)
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,last_success_at,parse_status,available_event_count,cache_updated_at,cache_expires_at,cached_payload)VALUES($1,now(),'success',1,now(),now()+interval '7 days',jsonb_build_object('events',jsonb_build_array(jsonb_build_object('id','event-1','calendar','School','title','Board meeting','start',to_jsonb(now()+interval '1 day'),'end',to_jsonb(now()+interval '2 hours 1 day'),'allDay',false)),'cachedAt',to_jsonb(now()),'staleAt',to_jsonb(now()+interval '7 days'),'usingCachedData',false,'unavailable',false))`, calendarID)
	}
	if err != nil {
		t.Fatal(err)
	}
	agendaID := uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by)VALUES($1,$2,'Today agenda','widget','','application/vnd.tilecast.widget+json',''::bytea,0,'ready',$3)`, agendaID, org, owner.User.ID)
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO widgets(asset_id,provider,config_version,configuration)VALUES($1,'agenda',2,jsonb_build_object('dataSourceId',$2::text,'fields',jsonb_build_array('title','date'),'maximumItems',10,'foregroundColor','#F5F7FA','backgroundColor','#0E141B'))`, agendaID, calendarID.String())
	}
	if err != nil {
		t.Fatal(err)
	}
	calendarPlaylist, err := service.Create(ctx, owner.User.ID, "Calendar rotation", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	calendarDuration := int64(30_000)
	calendarPlaylist, err = service.AddItem(ctx, calendarPlaylist.ID, owner.User.ID, ItemInput{AssetID: agendaID, DurationMS: &calendarDuration, DeliveryPolicy: "stream"})
	if err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, ctx, service, calendarPlaylist.ID, owner.User.ID)
	service.SetSourceProjector(media.NewService(pool, nil, media.Config{}))
	if _, err = service.Assign(ctx, screenID, calendarPlaylist.ID, owner.User.ID); !errors.Is(err, ErrConflict) || !strings.Contains(err.Error(), "Player update required") {
		t.Fatalf("expected old Player assignment to be blocked, got %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id,player_version_code)VALUES($1,22) ON CONFLICT(screen_id)DO UPDATE SET player_version_code=EXCLUDED.player_version_code`, screenID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Assign(ctx, screenID, calendarPlaylist.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	calendarManifest, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || len(calendarManifest.DataSources) != 1 || calendarManifest.DataSources[0].Provider != "calendar" || strings.Contains(string(calendarManifest.DataSources[0].Configuration), "private.example") || !strings.Contains(string(calendarManifest.DataSources[0].Configuration), "Board meeting") {
		t.Fatalf("calendar manifest data sources=%#v err=%v", calendarManifest.DataSources, err)
	}
	if calendarManifest.SchemaVersion != 12 || !strings.Contains(string(calendarManifest.DataSources[0].Configuration), `"fields"`) || strings.Contains(string(calendarManifest.DataSources[0].Configuration), `"displayMode"`) {
		t.Fatalf("calendar manifest did not use the typed v12 projection: %#v", calendarManifest)
	}
	if len(calendarManifest.Widgets) != 1 || calendarManifest.Widgets[0].Provider != "agenda" {
		t.Fatalf("calendar manifest widgets=%#v", calendarManifest.Widgets)
	}
	capabilities, _ := json.Marshal(NativePresentationCapabilities)
	if _, err = pool.Exec(ctx, `UPDATE screen_player_status SET presentation_schema_versions='{1}',native_presentation_capabilities=$2,web_runtime_version=1,web_bundle_limit_bytes=20971520 WHERE screen_id=$1`, screenID, capabilities); err != nil {
		t.Fatal(err)
	}
	declarativeManifest, declarativeETag, err := service.BuildManifest(ctx, screenID)
	if err != nil {
		t.Fatal(err)
	}
	if declarativeManifest.SchemaVersion != 13 || declarativeETag == "" || declarativeManifest.DataSources[0].DataDocument == nil || declarativeManifest.Widgets[0].Presentation == nil {
		t.Fatalf("declarative manifest was not projected: %#v", declarativeManifest)
	}
	if len(declarativeManifest.DataSources[0].Configuration) != 0 || len(declarativeManifest.Widgets[0].Configuration) != 0 {
		t.Fatal("v13 leaked Player-facing provider configuration")
	}
	if len(notifier.versions) < 3 {
		t.Fatalf("notifications=%v", notifier.versions)
	}

	// Media authoring defaults are read from the same organization registry, and
	// an item can explicitly delegate playback decisions to the Player policy.
	if _, err = pool.Exec(ctx, `INSERT INTO organization_runtime_settings(organization_id,settings) VALUES($1,$2::jsonb) ON CONFLICT(organization_id) DO UPDATE SET settings=organization_runtime_settings.settings||EXCLUDED.settings`, org, `{"media.image.default_fit_mode":"cover","player.playback.default_transition":"fade","player.playback.default_audio_enabled":false}`); err != nil {
		t.Fatal(err)
	}
	delegated, err := service.Create(ctx, owner.User.ID, "Delegated defaults", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	delegated, err = service.AddItem(ctx, delegated.ID, owner.User.ID, ItemInput{AssetID: imageID, UsePlayerDefaults: true})
	if err != nil || len(delegated.Items) != 1 || !delegated.Items[0].UsePlayerDefaults || delegated.Items[0].DurationMS != nil || delegated.Items[0].FitMode != "cover" || delegated.Items[0].Transition != "fade" || delegated.Items[0].AudioEnabled {
		t.Fatalf("delegated defaults item=%#v err=%v", delegated.Items, err)
	}
	publishDraftForTest(t, ctx, service, delegated.ID, owner.User.ID)
	if _, err = service.Assign(ctx, screenID, delegated.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	delegatedManifest, _, err := service.BuildManifest(ctx, screenID)
	if err != nil || delegatedManifest.DirectFallbackPlaylist == nil || !delegatedManifest.DirectFallbackPlaylist.Items[0].UsePlayerDefaults {
		t.Fatalf("delegated defaults manifest=%#v err=%v", delegatedManifest, err)
	}
}

func TestAddImageItemUsesConfiguredDefaultDuration(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE screen_player_status,screen_manifest_state,screen_playlist_assignments,playlist_items,playlists,media_jobs,upload_sessions,asset_variants,assets,device_pairing_sessions,device_credentials,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Playlist Duration Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	imageID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,duration_seconds,processing_status,created_by)VALUES($1,$2,'Gallery','image','gallery.png','image/png',$3,100,1920,1080,NULL,'ready',$4)`, imageID, org, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,duration_seconds,player_compatible)VALUES($1,$2,'original','local','originals/image','image/png',100,$3,1920,1080,NULL,TRUE)`, uuid.New(), imageID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, &testNotifier{})
	playlist, err := service.Create(ctx, owner.User.ID, "Gallery rotation", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	// An explicit duration is stored untouched.
	explicit := int64(5_000)
	playlist, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: imageID, DurationMS: &explicit})
	if err != nil {
		t.Fatal(err)
	}
	if len(playlist.Items) != 1 || playlist.Items[0].DurationMS == nil || *playlist.Items[0].DurationMS != 5_000 {
		t.Fatalf("explicit image duration was not stored: %#v", playlist)
	}
	// An explicit non-positive duration is still rejected.
	negative := int64(-1_000)
	if _, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: imageID, DurationMS: &negative}); err == nil {
		t.Fatal("image with negative duration was accepted")
	}
	// A configured organization default applies when the duration is omitted.
	if _, err = pool.Exec(ctx, `INSERT INTO organization_runtime_settings(organization_id,settings) VALUES($1,$2::jsonb) ON CONFLICT(organization_id) DO UPDATE SET settings=organization_runtime_settings.settings||EXCLUDED.settings`, org, `{"player.playback.default_image_duration_seconds": 25}`); err != nil {
		t.Fatal(err)
	}
	playlist, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: imageID})
	if err != nil {
		t.Fatal(err)
	}
	if len(playlist.Items) != 2 || playlist.Items[1].DurationMS == nil || *playlist.Items[1].DurationMS != 25_000 {
		t.Fatalf("configured image default was not applied: %#v", playlist)
	}
}
