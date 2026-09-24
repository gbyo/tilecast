package settings

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

type testNotifier struct {
	notes           int
	manifestChanges int
}

func (n *testNotifier) ConfigChanged(uuid.UUID, int64)   { n.notes++ }
func (n *testNotifier) ManifestChanged(uuid.UUID, int64) { n.manifestChanges++ }
func TestSettingsPolicyInheritanceAndRevision(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	lock, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	_, _ = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`)
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`)
	if err = database.Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	_, err = pool.Exec(ctx, `TRUNCATE organization_runtime_settings,user_preferences,screen_group_player_policies,screen_player_policies,screen_config_state,screen_group_memberships,screen_groups,screen_player_status,screen_manifest_state,screen_playlist_assignments,playlist_items,playlists,media_jobs,upload_sessions,asset_variants,assets,device_pairing_sessions,device_credentials,screens,sessions,audit_logs,users,organization_settings CASCADE`)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Settings Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	_ = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org)
	screen, group := uuid.New(), uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Lobby','android-tv','Google','ADT','14','0.8',1920,1080,2,'en-US','UTC')`, screen, org, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by)VALUES($1,$2,'Cafeteria Displays',$3)`, group, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by)VALUES($1,$2,$3)`, group, screen, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_config_state(screen_id)VALUES($1)`, screen); err != nil {
		t.Fatal(err)
	}
	notifier := &testNotifier{}
	service := NewService(pool, notifier, HardLimits{MaxUploadBytes: 20 << 30, MaxTakeoverMinutes: 1440, MaxWebsiteTimeout: 120, MaxPrefetchDays: 365})
	var initialization sync.WaitGroup
	initializationErrors := make(chan error, 16)
	for i := 0; i < 8; i++ {
		initialization.Add(2)
		go func() {
			defer initialization.Done()
			_, err := service.Organization(ctx)
			initializationErrors <- err
		}()
		go func() {
			defer initialization.Done()
			_, err := service.Preferences(ctx, owner.User.ID)
			initializationErrors <- err
		}()
	}
	initialization.Wait()
	close(initializationErrors)
	for initializationError := range initializationErrors {
		if initializationError != nil {
			t.Fatalf("concurrent settings initialization: %v", initializationError)
		}
	}
	document, err := service.Organization(ctx)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]any{"organization.name": "Settings Test", "organization.timezone": "America/New_York", "player.playback.default_volume": 0.5, "reliability.mode": "standard", "power.active_hours_timezone": "America/New_York", "power.active_hours_end": "16:00:00"}
	document, err = service.UpdateOrganization(ctx, owner.User.ID, document.Revision, values)
	if err != nil {
		t.Fatal(err)
	}
	var defaultTimezone string
	if err = pool.QueryRow(ctx, `SELECT default_timezone FROM organization_settings WHERE singleton`).Scan(&defaultTimezone); err != nil {
		t.Fatal(err)
	}
	if defaultTimezone != "America/New_York" {
		t.Fatalf("schedule default timezone=%q", defaultTimezone)
	}
	var manifestVersion int64
	if err = pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screen).Scan(&manifestVersion); err != nil {
		t.Fatalf("organization settings did not create manifest state: %v", err)
	}
	if manifestVersion != 2 || notifier.manifestChanges != 1 {
		t.Fatalf("manifest invalidation version=%d notifications=%d", manifestVersion, notifier.manifestChanges)
	}
	if document.Values["power.active_hours_end"] != "16:00" {
		t.Fatalf("active hours end=%#v", document.Values["power.active_hours_end"])
	}
	groupPolicy, err := service.PutGroupPolicy(ctx, owner.User.ID, group, 0, 100, map[string]any{"player.playback.default_volume": 0.4, "reliability.mode": "managed_kiosk"})
	if err != nil || groupPolicy.Revision != 1 {
		t.Fatalf("group policy: %#v %v", groupPolicy, err)
	}
	_, err = service.PutScreenPolicy(ctx, owner.User.ID, screen, 0, map[string]any{"player.playback.default_volume": 0.25, "power.keep_screen_on": false, "power.outside_active_hours_display": "custom_text", "power.outside_active_hours_text": "School is closed"})
	if err != nil {
		t.Fatal(err)
	}
	effective, err := service.Effective(ctx, screen)
	if err != nil {
		t.Fatal(err)
	}
	volume := effective.Values["player.playback.default_volume"]
	if volume.Value != 0.25 || volume.Source != "This screen" || effective.ConfigRevision < 3 {
		t.Fatalf("effective=%#v", effective)
	}
	if effective.Values["reliability.mode"].Value != "managed_kiosk" || effective.Values["power.keep_screen_on"].Value != false {
		t.Fatalf("reliability inheritance=%#v", effective.Values)
	}
	config, etag, err := service.PlayerConfiguration(ctx, screen)
	regionalProfile, _ := config.Playback["regionalFormat"].(RegionalFormatting)
	if err != nil || config.Playback["defaultVolume"] != 0.25 || config.Reliability["mode"] != "managed_kiosk" || config.Power["keepScreenOn"] != false || config.Power["outsideActiveHoursDisplay"] != "custom_text" || config.Power["outsideActiveHoursText"] != "School is closed" || config.Power["blackScreenFallback"] != false || config.LinuxKiosk["fullscreenEnabled"] != true || config.LinuxKiosk["preventDisplaySleep"] != true || etag == "" || regionalProfile.Locale != "en-US" || regionalProfile.Timezone != "America/New_York" || regionalProfile.FirstDayOfWeek != "sunday" {
		t.Fatalf("config=%#v etag=%q err=%v", config, etag, err)
	}
	if notifier.notes < 3 {
		t.Fatalf("notifications=%d", notifier.notes)
	}
	if _, err = service.UpdateOrganization(ctx, owner.User.ID, document.Revision-1, values); err != ErrRevisionConflict {
		t.Fatalf("revision conflict=%v", err)
	}
}
