package playlists

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

// A playlist reached only through a Display Group assignment, or an active
// takeover, is in use. Deleting it would break the manifest of every screen
// that receives it. Content a screen returns to when it leaves a group must
// never point at something deleted while the screen was a member.
func TestDeleteRefusesPlaylistsInUseOutsideScreenAssignments(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE takeover_screen_states,takeover_targets,takeovers,screen_group_membership_schedule_snapshots,screen_group_membership_snapshots,schedule_targets,schedules,screen_group_playlist_assignments,screen_group_memberships,screen_groups,screen_player_status,screen_manifest_state,screen_playlist_assignments,playlist_items,playlists,asset_variants,assets,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Delete Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	memberScreen, joiningScreen, takeoverScreen := uuid.New(), uuid.New(), uuid.New()
	for _, screen := range []uuid.UUID{memberScreen, joiningScreen, takeoverScreen} {
		if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Screen','android-tv','Google','ADT-3','14','0.4.0',1920,1080,2,'en-US','UTC')`, screen, org, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
	}
	imageID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by)VALUES($1,$2,'Welcome','image','welcome.png','image/png',$3,100,1920,1080,'ready',$4)`, imageID, org, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible)VALUES($1,$2,'original','local','originals/image','image/png',100,$3,1920,1080,TRUE)`, uuid.New(), imageID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, &testNotifier{})
	scheduler := scheduling.NewService(pool, &testNotifier{}, scheduling.Limits{MaxSchedules: 1000, MaxTargetsPerSchedule: 250, MaxGroupsPerScreen: 50, PrefetchDays: 14, ActivationGraceSeconds: 30, ClockSkewWarningSeconds: 300})
	service.SetScheduling(scheduler)
	duration := int64(10_000)
	published := func(name string) uuid.UUID {
		t.Helper()
		playlist, createErr := service.Create(ctx, owner.User.ID, name, "", "static")
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, createErr = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: imageID, DurationMS: &duration}); createErr != nil {
			t.Fatal(createErr)
		}
		publishDraftForTest(t, ctx, service, playlist.ID, owner.User.ID)
		return playlist.ID
	}

	groupPlaylist := published("Group loop")
	group, err := scheduler.CreateGroup(ctx, owner.User.ID, "Front of house", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = scheduler.AddScreen(ctx, group.ID, memberScreen, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if err = service.AssignGroupPresentation(ctx, group.ID, &groupPlaylist, nil, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if err = service.Delete(ctx, groupPlaylist, owner.User.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("deleting a group-assigned playlist = %v, want conflict", err)
	}
	if _, _, err = service.BuildManifest(ctx, memberScreen); err != nil {
		t.Fatalf("group member manifest: %v", err)
	}

	takeoverPlaylist := published("Evacuation")
	takeoverID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO takeovers(id,organization_id,name,playlist_id,status,activated_at,expires_at,activated_by) VALUES($1,$2,'Evacuation',$3,'active',now()-interval '1 minute',now()+interval '1 hour',$4)`, takeoverID, org, takeoverPlaylist, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if err = service.Delete(ctx, takeoverPlaylist, owner.User.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("deleting an active takeover playlist = %v, want conflict", err)
	}

	// The joining screen's own playlist is snapshotted while it is a member.
	ownPlaylist := published("Own loop")
	if _, err = service.Assign(ctx, joiningScreen, ownPlaylist, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if err = scheduler.AddScreen(ctx, group.ID, joiningScreen, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if err = service.Delete(ctx, ownPlaylist, owner.User.ID); err != nil {
		t.Fatalf("a playlist no screen currently receives may be deleted: %v", err)
	}
	if err = scheduler.RemoveScreen(ctx, group.ID, joiningScreen, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := service.Assignment(ctx, joiningScreen)
	if err != nil {
		t.Fatal(err)
	}
	if restored.PlaylistID != nil && *restored.PlaylistID == ownPlaylist {
		t.Fatalf("leaving the group restored a deleted playlist: %#v", restored)
	}
	if _, _, err = service.BuildManifest(ctx, joiningScreen); err != nil {
		t.Fatalf("manifest after leaving the group: %v", err)
	}
}

// The Server never activates a one-time window outside its date bounds (a
// Campaign block left outside the Campaign). Player evaluators do not apply
// date bounds to one-time windows, so the manifest must not carry it.
func TestManifestOmitsOneTimeSchedulesOutsideTheirDateBounds(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE takeover_screen_states,takeover_targets,takeovers,screen_group_membership_schedule_snapshots,screen_group_membership_snapshots,schedule_targets,schedules,screen_group_playlist_assignments,screen_group_memberships,screen_groups,screen_player_status,screen_manifest_state,screen_playlist_assignments,playlist_items,playlists,asset_variants,assets,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Bounds Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	screen, imageID := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Screen','android-tv','Google','ADT-3','14','0.4.0',1920,1080,2,'en-US','UTC')`, screen, org, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by)VALUES($1,$2,'Welcome','image','welcome.png','image/png',$3,100,1920,1080,'ready',$4)`, imageID, org, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible)VALUES($1,$2,'original','local','originals/image','image/png',100,$3,1920,1080,TRUE)`, uuid.New(), imageID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, &testNotifier{})
	scheduler := scheduling.NewService(pool, &testNotifier{}, scheduling.Limits{MaxSchedules: 1000, MaxTargetsPerSchedule: 250, MaxGroupsPerScreen: 50, PrefetchDays: 14, ActivationGraceSeconds: 30, ClockSkewWarningSeconds: 300})
	service.SetScheduling(scheduler)
	duration := int64(10_000)
	playlist, err := service.Create(ctx, owner.User.ID, "Event", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.AddItem(ctx, playlist.ID, owner.User.ID, ItemInput{AssetID: imageID, DurationMS: &duration}); err != nil {
		t.Fatal(err)
	}
	publishDraftForTest(t, ctx, service, playlist.ID, owner.User.ID)
	if _, err = service.Assign(ctx, screen, playlist.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	start, end := time.Now().Add(-time.Hour), time.Now().Add(time.Hour)
	yesterday := time.Now().UTC().AddDate(0, 0, -2).Format("2006-01-02")
	for name, last := range map[string]*string{"Bounded": &yesterday, "Unbounded": nil} {
		if _, err = scheduler.Create(ctx, owner.User.ID, scheduling.Input{Name: name, PlaylistID: playlist.ID, Type: scheduling.OneTime, Timezone: "UTC", Priority: 500, Enabled: true, OneTimeStart: &start, OneTimeEnd: &end, EndDate: last, Targets: []scheduling.Target{{Type: "screen", ID: screen}}}); err != nil {
			t.Fatal(err)
		}
	}
	manifest, _, err := service.BuildManifest(ctx, screen)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Schedules) != 1 || manifest.Schedules[0].EndDate != nil {
		t.Fatalf("manifest schedules=%#v, want only the unbounded window", manifest.Schedules)
	}
}
