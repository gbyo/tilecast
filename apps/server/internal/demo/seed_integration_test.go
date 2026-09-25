package demo

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/campaigns"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/presentations"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
	"github.com/tilecast/tilecast/apps/server/internal/span"
)

// openDemoDatabase connects to TEST_DATABASE_URL under the shared integration
// lock, so the full-database wipe cannot race another package's fixtures.
func openDemoDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lockPool.Close)
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lock.Release)
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = lock.Exec(context.Background(), `SELECT pg_advisory_unlock(7421999)`) })
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// newTestServices wires the services the way cmd/tilecast does, with a real
// media worker so seeded images are processed rather than faked.
func newTestServices(t *testing.T, pool *pgxpool.Pool) Services {
	t.Helper()
	ffmpeg, ffmpegErr := exec.LookPath("ffmpeg")
	ffprobe, ffprobeErr := exec.LookPath("ffprobe")
	if ffmpegErr != nil || ffprobeErr != nil {
		t.Skip("ffmpeg and ffprobe are required to process demo media")
	}
	catalog, err := contentdefs.Load()
	if err != nil {
		t.Fatal(err)
	}
	storage, err := media.NewLocalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	presence := devices.NewPresenceHub()
	deviceService := devices.NewService(pool, presence, "http://localhost:8080")
	mediaService := media.NewService(pool, storage, media.Config{
		MaxUploadBytes: 10737418240, ReservedFreeBytes: 1, FFmpegPath: ffmpeg, FFprobePath: ffprobe, Workers: 2,
		Profile:     media.CompatibilityProfile{MaxWidth: 1920, MaxHeight: 1080, MaxFrameRate: 60},
		Website:     media.WebsitePolicy{DefaultTimeoutSeconds: 20, MaxTimeoutSeconds: 120, MinRefreshSeconds: 30, MaxAllowedHosts: 25, MaxWebsites: 500},
		SourceFetch: media.SourceFetchPolicy{Timeout: 5 * time.Second, MaximumBytes: 1 << 20, MaximumRedirects: 3, MinimumRefresh: 5 * time.Minute, MaximumRefresh: 24 * time.Hour},
	})
	mediaService.SetContentDefinitions(catalog)
	playlistService := playlists.NewService(pool, deviceService)
	playlistService.SetContentDefinitions(catalog)
	spanService := span.NewService(pool, storage, span.Config{FFmpegPath: ffmpeg, FFprobePath: ffprobe}, deviceService)
	playlistService.SetSpanProjector(spanService)
	presentationService := presentations.NewService(pool, deviceService)
	presentationService.SetPresentationReadiness(playlistService)
	playlistService.SetPresentationOverrides(presentationService)
	pluginService := plugins.NewService(pool, deviceService)
	pluginService.SetManifestInvalidator(playlistService)
	playlistService.SetPluginProjector(pluginService)
	layoutService := layouts.NewService(pool)
	layoutService.SetNotifier(deviceService)
	layoutService.SetManifestInvalidator(playlistService)
	mediaService.SetAssetInvalidator(playlistService)
	playlistService.SetSourceProjector(mediaService)
	limits := scheduling.Limits{MaxSchedules: 1000, MaxTargetsPerSchedule: 250, MaxGroupsPerScreen: 50, PrefetchDays: 14, ActivationGraceSeconds: 30, ClockSkewWarningSeconds: 300}
	schedulingService := scheduling.NewService(pool, deviceService, limits)
	schedulingService.SetPresentationReadiness(playlistService)
	playlistService.SetScheduling(schedulingService)
	settingsService := settings.NewService(pool, deviceService, settings.HardLimits{MaxUploadBytes: 10737418240, MaxTakeoverMinutes: 24 * 60, MaxWebsiteTimeout: 120, MaxPrefetchDays: 14})
	schedulingService.SetOrganizationSettingsProvider(settingsService)
	campaignService := campaigns.NewService(pool, deviceService)
	campaignService.SetPresentationChecker(playlistService)
	campaignService.SetScheduler(schedulingService)
	campaignService.SetSchedulingLimits(limits)
	approvalService := approvals.NewService(pool, settingsService)
	approvalService.SetProvider(approvals.TypePlaylist, playlistService)
	approvalService.SetProvider(approvals.TypeLayout, layoutService)
	approvalService.SetProvider(approvals.TypeCampaign, campaignService)
	playlistService.SetApprovalGate(approvalService.GateTx)

	workers := media.NewWorkerPool(mediaService, slog.New(slog.DiscardHandler))
	workers.SetExtraProcessor(spanService.ProcessJob)
	ctx, cancel := context.WithCancel(context.Background())
	workers.Start(ctx)
	t.Cleanup(func() {
		cancel()
		workers.Stop()
	})
	return Services{
		DB: pool, Auth: auth.NewService(pool, time.Hour), Devices: deviceService, Presence: presence, Media: mediaService,
		Playlists: playlistService, Layouts: layoutService, Scheduling: schedulingService, Approvals: approvalService,
		Plugins: pluginService, Campaigns: campaignService, Settings: settingsService,
	}
}

func TestSeedRefusesAnInstallationItDidNotCreate(t *testing.T) {
	pool := openDemoDatabase(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	if _, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Real District", OwnerName: "Real Owner", Username: "owner", Password: "correct horse battery staple"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Seed(ctx, Services{DB: pool}, ScenarioBasic); !errors.Is(err, errNotDemoDatabase) {
		t.Fatalf("seeding over a real installation: %v", err)
	}
	var users int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE username='owner'`).Scan(&users); err != nil || users != 1 {
		t.Fatalf("the real installation was changed: users=%d err=%v", users, err)
	}
	if _, err := Seed(ctx, Services{DB: pool}, "no-such-scenario"); !errors.As(err, new(UnknownScenarioError)) {
		t.Fatalf("unknown scenario: %v", err)
	}
}

func TestSeedScenariosAreDeterministicAndRerunnable(t *testing.T) {
	pool := openDemoDatabase(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	svc := newTestServices(t, pool)

	players, err := Seed(ctx, svc, ScenarioBasic)
	if err != nil {
		t.Fatal(err)
	}
	if len(players) != 3 {
		t.Fatalf("basic players = %d, want 3", len(players))
	}
	assertCount(t, pool, `SELECT count(*) FROM screens`, 4)

	first, err := Seed(ctx, svc, ScenarioKitchenSink)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func() map[string]int {
		counts := map[string]int{}
		for _, table := range []string{"users", "locations", "screens", "screen_groups", "screen_group_memberships", "assets", "content_tags", "playlists", "layouts", "schedules", "campaigns", "plugin_installations", "device_credentials"} {
			var count int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&count); err != nil {
				t.Fatal(err)
			}
			counts[table] = count
		}
		return counts
	}
	before := snapshot()
	want := map[string]int{"users": 4, "locations": 4, "screens": 13, "screen_groups": 4, "screen_group_memberships": 10, "playlists": 5, "layouts": 2, "schedules": 3, "campaigns": 1, "content_tags": 4, "assets": 10, "plugin_installations": 2}
	for table, count := range want {
		if before[table] != count {
			t.Errorf("%s = %d, want %d", table, before[table], count)
		}
	}

	// A second seed of the same scenario is a reset: same IDs, same counts.
	second, err := Seed(ctx, svc, ScenarioKitchenSink)
	if err != nil {
		t.Fatal(err)
	}
	if after := snapshot(); len(after) != len(before) {
		t.Fatal("snapshot changed shape")
	} else {
		for table, count := range before {
			if after[table] != count {
				t.Errorf("after reset %s = %d, want %d", table, after[table], count)
			}
		}
	}
	if len(first) != len(second) || len(second) != 8 {
		t.Fatalf("players = %d then %d, want 8", len(first), len(second))
	}
	for i := range first {
		if first[i].ScreenID != second[i].ScreenID {
			t.Fatalf("simulated player order changed at %d", i)
		}
		if first[i].Credential == second[i].Credential {
			t.Fatal("a reset reused a device credential instead of enrolling again")
		}
	}

	// Stable IDs are the contract browser tests rely on.
	for name, id := range map[string]uuid.UUID{"owner": IDs.Owner, "screen": IDs.CafeteriaEast, "playlist": IDs.MorningAnnouncements, "layout": IDs.HallwaySplit, "group": IDs.CafeteriaDisplays, "location": IDs.HighSchool, "asset": IDs.WelcomeSlide} {
		var exists bool
		query := map[string]string{"owner": "users", "screen": "screens", "playlist": "playlists", "layout": "layouts", "group": "screen_groups", "location": "locations", "asset": "assets"}[name]
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM `+query+` WHERE id=$1)`, id).Scan(&exists); err != nil || !exists {
			t.Errorf("%s %s missing after reset: %v", name, id, err)
		}
	}

	statuses := map[uuid.UUID]devices.Status{}
	screens, err := svc.Devices.ListScreens(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, screen := range screens {
		statuses[screen.ID] = screen.Status
	}
	// No simulator runs in this test, so only the silent states are final.
	for id, want := range map[uuid.UUID]devices.Status{IDs.BoardRoom: devices.StatusStale, IDs.StadiumConcourse: devices.StatusOffline, IDs.MiddleSchoolHallway: devices.StatusDisabled} {
		if statuses[id] != want {
			t.Errorf("screen %s status = %s, want %s", id, statuses[id], want)
		}
	}
	var published, drafts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE published_revision_id IS NOT NULL),count(*) FILTER (WHERE published_revision_id IS NULL) FROM layouts`).Scan(&published, &drafts); err != nil || published != 1 || drafts != 1 {
		t.Errorf("layouts published=%d draft=%d err=%v", published, drafts, err)
	}
	manifest, _, err := svc.Playlists.BuildManifest(ctx, IDs.CafeteriaEast)
	if err != nil || len(manifest.Assets) == 0 {
		t.Fatalf("Cafeteria East manifest: assets=%d err=%v", len(manifest.Assets), err)
	}
}

func assertCount(t *testing.T, pool *pgxpool.Pool, query string, want int) {
	t.Helper()
	var got int
	if err := pool.QueryRow(context.Background(), query).Scan(&got); err != nil || got != want {
		t.Fatalf("%s = %d, want %d (err %v)", query, got, want, err)
	}
}
