package plugins

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

type noiseHistoryEnvironment struct {
	pool     *pgxpool.Pool
	service  *Service
	screenA  uuid.UUID
	screenB  uuid.UUID
	instance uuid.UUID
	userID   uuid.UUID
}

func setupNoiseHistory(t *testing.T) (context.Context, noiseHistoryEnvironment) {
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
	t.Cleanup(func() { _, _ = lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) })
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	environment := noiseHistoryEnvironment{pool: pool, screenA: uuid.New(), screenB: uuid.New(), userID: uuid.New()}
	organizationID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Noise History Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','history-owner','unused','owner',TRUE)`, environment.userID); err != nil {
		t.Fatal(err)
	}
	for _, record := range []struct {
		id   uuid.UUID
		name string
	}{{environment.screenA, "Cafeteria"}, {environment.screenB, "Gym"}} {
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
	environment.service = NewService(pool, nil)
	installPluginsForTest(t, pool, NoiseMeterID)
	meter, err := environment.service.CreateNoiseMeter(ctx, environment.userID, validNoiseMeter())
	if err != nil {
		t.Fatal(err)
	}
	environment.instance = meter.ID
	return ctx, environment
}

/** One bucket, aligned to the ten-second grid the Player uses. */
func historyRecord(at time.Time, average, peak float64, warningMS, loudMS, triggers int) NoiseHistoryRecord {
	return NoiseHistoryRecord{
		StartedAt: at.UTC().Truncate(10 * time.Second), AverageLevel: average, PeakLevel: peak,
		MonitoredMS: 10_000, WarningMS: warningMS, LoudMS: loudMS, TriggerCount: triggers,
	}
}

func TestNoiseHistoryIngestionIsIdempotentAndScoped(t *testing.T) {
	ctx, env := setupNoiseHistory(t)
	base := time.Now().UTC().Add(-time.Hour).Truncate(10 * time.Second)
	batch := []NoiseHistoryRecord{
		historyRecord(base, 40, 55, 0, 0, 0),
		historyRecord(base.Add(10*time.Second), 85, 95, 2_000, 7_000, 1),
	}
	accepted, err := env.service.RecordNoiseHistory(ctx, env.screenA, batch)
	if err != nil || accepted != len(batch) {
		t.Fatalf("first submission: accepted=%d err=%v", accepted, err)
	}

	// The heartbeat response was lost, so the Player sends the same batch again.
	// A retry has to be harmless, not a second copy of a room's history.
	if accepted, err = env.service.RecordNoiseHistory(ctx, env.screenA, batch); err != nil || accepted != len(batch) {
		t.Fatalf("retry: accepted=%d err=%v", accepted, err)
	}
	var rows int
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history WHERE screen_id=$1`, env.screenA).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("a retried batch duplicated history: %d rows", rows)
	}

	// The screen comes from the authenticated device, so the same bucket start
	// on another screen is another screen's history rather than a conflict.
	if _, err = env.service.RecordNoiseHistory(ctx, env.screenB, batch[:1]); err != nil {
		t.Fatal(err)
	}
	var owner uuid.UUID
	if err = env.pool.QueryRow(ctx, `SELECT screen_id FROM noise_meter_history
		WHERE bucket_started_at=$1 AND screen_id=$2`, batch[0].StartedAt, env.screenB).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != env.screenB {
		t.Fatalf("history was attributed to the wrong screen: %v", owner)
	}
	// Every row is attributed to the instance that was measuring.
	var instances int
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history WHERE plugin_instance_id=$1`, env.instance).Scan(&instances); err != nil {
		t.Fatal(err)
	}
	if instances != 3 {
		t.Fatalf("expected every row to name its instance, got %d", instances)
	}
}

func TestNoiseHistoryRejectsUnusableAndOversizedBatches(t *testing.T) {
	ctx, env := setupNoiseHistory(t)
	base := time.Now().UTC().Add(-time.Hour).Truncate(10 * time.Second)

	// A bounded heartbeat: more than the cap is refused outright rather than
	// letting one request carry an unbounded backlog.
	oversized := make([]NoiseHistoryRecord, MaxNoiseHistoryBatch+1)
	for index := range oversized {
		oversized[index] = historyRecord(base.Add(time.Duration(index)*10*time.Second), 30, 40, 0, 0, 0)
	}
	if _, err := env.service.RecordNoiseHistory(ctx, env.screenA, oversized); err == nil {
		t.Fatal("expected an oversized batch to be rejected")
	}

	// Unusable records are consumed rather than stored, so a Player cannot loop
	// on a bucket it can never get accepted.
	bad := []NoiseHistoryRecord{
		historyRecord(time.Now().UTC().Add(48*time.Hour), 50, 60, 0, 0, 0),
		historyRecord(base.Add(20*time.Second), 50, 60, 9_000, 9_000, 0),
		{StartedAt: base.Add(30 * time.Second), AverageLevel: 200, PeakLevel: 400, MonitoredMS: 10_000},
	}
	accepted, err := env.service.RecordNoiseHistory(ctx, env.screenA, bad)
	if err != nil || accepted != len(bad) {
		t.Fatalf("unusable batch: accepted=%d err=%v", accepted, err)
	}
	var stored int
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history WHERE screen_id=$1`, env.screenA).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	// Only the third survives, clamped into range; the future one and the one
	// whose durations exceed its monitored time are dropped.
	if stored != 1 {
		t.Fatalf("expected only the salvageable record to be stored, got %d", stored)
	}
	var average, peak float64
	if err = env.pool.QueryRow(ctx, `SELECT average_level,peak_level FROM noise_meter_history WHERE screen_id=$1`, env.screenA).Scan(&average, &peak); err != nil {
		t.Fatal(err)
	}
	if average != 100 || peak != 100 {
		t.Fatalf("levels were not clamped into the relative scale: %v %v", average, peak)
	}
}

func TestNoiseHistoryQueriesAndRetention(t *testing.T) {
	ctx, env := setupNoiseHistory(t)
	// Two minutes of history: the first quiet, the second loud, and a gap of a
	// minute between them that nobody monitored.
	base := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Minute)
	var batch []NoiseHistoryRecord
	for index := 0; index < 6; index++ {
		batch = append(batch, historyRecord(base.Add(time.Duration(index)*10*time.Second), 40, 50, 0, 0, 0))
	}
	for index := 0; index < 6; index++ {
		at := base.Add(2*time.Minute + time.Duration(index)*10*time.Second)
		batch = append(batch, historyRecord(at, 90, 96, 1_000, 9_000, 0))
	}
	// One trigger, counted by the Player where the bar actually appeared.
	batch[6].TriggerCount = 1
	if _, err := env.service.RecordNoiseHistory(ctx, env.screenA, batch); err != nil {
		t.Fatal(err)
	}
	filter := NoiseHistoryFilter{
		InstanceID: env.instance, ScreenIDs: []uuid.UUID{env.screenA, env.screenB},
		From: base.Add(-time.Hour), To: base.Add(time.Hour), Timezone: "UTC",
	}

	summary, err := env.service.NoiseHistorySummaryFor(ctx, filter)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Buckets != 12 || summary.AverageLevel == nil || *summary.AverageLevel != 65 {
		t.Fatalf("summary average is not time weighted: %#v", summary)
	}
	if summary.PeakLevel == nil || *summary.PeakLevel != 96 {
		t.Fatalf("summary peak: %#v", summary.PeakLevel)
	}
	if summary.LoudMS != 54_000 || summary.WarningMS != 6_000 || summary.MonitoredMS != 120_000 {
		t.Fatalf("durations did not sum: loud=%d warning=%d monitored=%d", summary.LoudMS, summary.WarningMS, summary.MonitoredMS)
	}
	if summary.NormalMS != 60_000 {
		t.Fatalf("normal time is monitored time less the two bands, got %d", summary.NormalMS)
	}
	if summary.WarningEvents != 1 {
		t.Fatalf("warning events come from the Player's own count, got %d", summary.WarningEvents)
	}
	// The loud run is six contiguous buckets, and it stops at the gap.
	if summary.LongestLoudMS != 54_000 {
		t.Fatalf("longest continuous loud run: %d", summary.LongestLoudMS)
	}

	points, err := env.service.NoiseHistorySeries(ctx, filter, "minute")
	if err != nil {
		t.Fatal(err)
	}
	// A minute nobody measured is absent rather than a zero: two points, not three.
	if len(points) != 2 {
		t.Fatalf("missing periods must stay missing, got %d points: %#v", len(points), points)
	}
	if points[0].AverageLevel != 40 || points[1].AverageLevel != 90 || points[1].PeakLevel != 96 {
		t.Fatalf("aggregated points: %#v", points)
	}
	if points[1].LoudMS != 54_000 || points[1].WarningMS != 6_000 {
		t.Fatalf("aggregated durations: %#v", points[1])
	}
	if _, err = env.service.NoiseHistorySeries(ctx, filter, "century"); err == nil {
		t.Fatal("expected an unknown resolution to be rejected")
	}

	days, err := env.service.NoiseHistoryDays(ctx, filter)
	if err != nil || len(days) != 1 {
		t.Fatalf("daily rollup: %#v %v", days, err)
	}
	if days[0].TriggerCount != 1 || days[0].PeakLevel != 96 {
		t.Fatalf("daily rollup values: %#v", days[0])
	}

	// A screen the caller cannot see contributes nothing.
	narrowed := filter
	narrowed.ScreenIDs = []uuid.UUID{env.screenB}
	scoped, err := env.service.NoiseHistorySummaryFor(ctx, narrowed)
	if err != nil || scoped.Buckets != 0 {
		t.Fatalf("history leaked across the screen scope: %#v %v", scoped, err)
	}

	screens, err := env.service.NoiseHistoryScreens(ctx, filter)
	if err != nil || len(screens) != 1 || screens[0].ScreenID != env.screenA {
		t.Fatalf("screens with history: %#v %v", screens, err)
	}

	// Raw export is bounded to the same range and screens.
	exported := 0
	if err = env.service.NoiseHistoryRaw(ctx, filter, 1_000, func(string, NoiseHistoryPoint) error {
		exported++
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if exported != 12 {
		t.Fatalf("raw export covered %d records", exported)
	}

	daily, err := env.service.NoiseHistoryDailyExport(ctx, filter)
	if err != nil || len(daily) != 1 || daily[0].LongestLoudMS != 54_000 {
		t.Fatalf("daily export: %#v %v", daily, err)
	}

	// Retention: an old bucket goes, a current one stays. Shortening the window
	// must never take newer history with it.
	old := time.Now().UTC().Add(-20 * 24 * time.Hour).Truncate(10 * time.Second)
	if _, err = env.pool.Exec(ctx, `INSERT INTO noise_meter_history
		(screen_id,bucket_started_at,plugin_instance_id,average_level,peak_level,monitored_ms,warning_ms,loud_ms,trigger_count)
		VALUES($1,$2,$3,20,30,10000,0,0,0)`, env.screenA, old, env.instance); err != nil {
		t.Fatal(err)
	}
	removed, err := env.service.PruneNoiseHistory(ctx, 500)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("expected one expired bucket to be pruned, got %d", removed)
	}
	var remaining int
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history WHERE screen_id=$1`, env.screenA).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 12 {
		t.Fatalf("pruning removed newer records: %d remain", remaining)
	}
}

// The display window is stored and projected as configured, and it governs the
// bar alone: a meter that is only allowed to show during class still measures
// and still delivers history the rest of the day.
func TestNoiseMeterScheduleRoundTripsIntoTheManifest(t *testing.T) {
	ctx, env := setupNoiseHistory(t)
	stored, err := env.service.GetNoiseMeter(ctx, env.instance)
	if err != nil {
		t.Fatal(err)
	}
	update := stored.NoiseMeterInput
	start, end := "08:00", "15:30"
	update.ScheduleEnabled = true
	update.ScheduleStartTime, update.ScheduleEndTime = &start, &end
	update.ScheduleDaysOfWeek = []int{1, 2, 3, 4, 5}
	update.ScheduleTimezone = "America/Chicago"
	saved, err := env.service.UpdateNoiseMeter(ctx, env.instance, env.userID, update)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.ScheduleEnabled || saved.ScheduleStartTime == nil || *saved.ScheduleStartTime != "08:00" ||
		saved.ScheduleEndTime == nil || *saved.ScheduleEndTime != "15:30" ||
		saved.ScheduleTimezone != "America/Chicago" || len(saved.ScheduleDaysOfWeek) != 5 {
		t.Fatalf("display window was not stored as configured: %#v", saved)
	}

	projected, err := env.service.ManifestForScreen(ctx, env.screenA)
	if err != nil || len(projected) != 1 {
		t.Fatalf("manifest: %#v %v", projected, err)
	}
	config, ok := projected[0].Config.(ManifestNoiseMeterConfig)
	if !ok || !config.ScheduleEnabled || config.ScheduleStartTime == nil ||
		*config.ScheduleStartTime != "08:00" || config.ScheduleTimezone != "America/Chicago" {
		t.Fatalf("display window did not reach the Player: %#v", projected[0].Config)
	}

	// History is unaffected by the window: the room is still measured outside it.
	base := time.Now().UTC().Add(-time.Hour).Truncate(10 * time.Second)
	if _, err = env.service.RecordNoiseHistory(ctx, env.screenA,
		[]NoiseHistoryRecord{historyRecord(base, 45, 60, 0, 0, 0)}); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history WHERE screen_id=$1`, env.screenA).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("a display window must not stop measurement: %d rows", rows)
	}

	// Switching the window back off clears its bounds rather than leaving a
	// half-configured window behind.
	update.ScheduleEnabled = false
	update.ScheduleStartTime, update.ScheduleEndTime = nil, nil
	update.ScheduleDaysOfWeek = []int{}
	if saved, err = env.service.UpdateNoiseMeter(ctx, env.instance, env.userID, update); err != nil {
		t.Fatal(err)
	}
	if saved.ScheduleEnabled || saved.ScheduleStartTime != nil || saved.ScheduleEndTime != nil {
		t.Fatalf("window was not cleared: %#v", saved)
	}
}

func TestNoiseHistoryConsumedWhenTheMeterNoLongerApplies(t *testing.T) {
	ctx, env := setupNoiseHistory(t)
	stored, err := env.service.GetNoiseMeter(ctx, env.instance)
	if err != nil {
		t.Fatal(err)
	}
	// History was switched off while the Player was offline. Its backlog is
	// consumed rather than retried forever, and none of it is stored.
	update := stored.NoiseMeterInput
	update.HistoryEnabled = false
	if _, err = env.service.UpdateNoiseMeter(ctx, env.instance, env.userID, update); err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(-time.Hour).Truncate(10 * time.Second)
	batch := []NoiseHistoryRecord{historyRecord(base, 50, 60, 0, 0, 0)}
	accepted, err := env.service.RecordNoiseHistory(ctx, env.screenA, batch)
	if err != nil || accepted != 1 {
		t.Fatalf("disabled history: accepted=%d err=%v", accepted, err)
	}
	var rows int
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("history was stored for a meter that is not collecting: %d rows", rows)
	}

	// Deleting the instance takes its history with it rather than leaving rows
	// no retention window owns.
	update.HistoryEnabled = true
	if _, err = env.service.UpdateNoiseMeter(ctx, env.instance, env.userID, update); err != nil {
		t.Fatal(err)
	}
	if _, err = env.service.RecordNoiseHistory(ctx, env.screenA, batch); err != nil {
		t.Fatal(err)
	}
	if err = env.service.DeleteNoiseMeter(ctx, env.instance, env.userID); err != nil {
		t.Fatal(err)
	}
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("history outlived its instance: %d rows", rows)
	}
}
