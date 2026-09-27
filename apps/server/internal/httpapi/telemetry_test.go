package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

// Hysteresis is the mechanism that stops a value hovering at the boundary from
// producing an endless enter/exit stream, so it is tested on its own.
func TestThresholdHysteresis(t *testing.T) {
	storage := telemetryThresholdsByCondition["storage_pressure"]

	// Rising: nothing happens until the entry level, not the exit level.
	for _, value := range []float64{50, 80, 85, 89.9} {
		if enter, _ := storage.crossed(value, false); enter {
			t.Fatalf("%v%% entered storage pressure before the threshold", value)
		}
	}
	if enter, _ := storage.crossed(90, false); !enter {
		t.Fatal("90% did not enter storage pressure")
	}

	// Falling: the condition holds until well below the entry level. This gap
	// is the whole point — a cache sitting at 90% cannot flap.
	for _, value := range []float64{89, 85, 80.1} {
		if _, exit := storage.crossed(value, true); exit {
			t.Fatalf("%v%% exited storage pressure inside the hysteresis band", value)
		}
	}
	if _, exit := storage.crossed(80, true); !exit {
		t.Fatal("80% did not exit storage pressure")
	}
}

func TestThresholdHysteresisWhereLowerIsWorse(t *testing.T) {
	black := telemetryThresholdsByCondition["black_output"]
	if enter, _ := black.crossed(0.01, false); !enter {
		t.Fatal("a dark frame did not enter the black-output condition")
	}
	// Dim but not black must not clear it, or genuinely dark content flaps.
	if _, exit := black.crossed(0.05, true); exit {
		t.Fatal("a dim frame exited the black-output condition too early")
	}
	if _, exit := black.crossed(0.09, true); !exit {
		t.Fatal("a bright frame did not clear the black-output condition")
	}
}

func TestEveryThresholdHasARealHysteresisGap(t *testing.T) {
	for _, threshold := range telemetryThresholds {
		if threshold.HigherIsWorse && threshold.Exit >= threshold.Enter {
			t.Errorf("%s: exit %v is not below enter %v, so it can flap",
				threshold.Condition, threshold.Exit, threshold.Enter)
		}
		if !threshold.HigherIsWorse && threshold.Exit <= threshold.Enter {
			t.Errorf("%s: exit %v is not above enter %v, so it can flap",
				threshold.Condition, threshold.Exit, threshold.Enter)
		}
		if threshold.Cooldown <= 0 {
			t.Errorf("%s has no cooldown", threshold.Condition)
		}
	}
	for _, condition := range telemetryStateConditions {
		if condition.Cooldown <= 0 {
			t.Errorf("%s has no cooldown", condition.Condition)
		}
	}
}

func postTelemetry(t *testing.T, env activityTestEnvironment, input telemetrySampleInput) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(input)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/player/telemetry", bytes.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), deviceContextKey,
		devices.DevicePrincipal{ScreenID: env.screenID, Enabled: true}))
	response := httptest.NewRecorder()
	env.server.ingestTelemetry(response, request)
	return response
}

func telemetryEventCount(t *testing.T, env activityTestEnvironment, eventType string) int64 {
	t.Helper()
	var count int64
	if err := env.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM player_activity_events WHERE screen_id=$1 AND event_type=$2`,
		env.screenID, eventType).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func pointer[T any](value T) *T { return &value }

func TestTelemetrySnapshotKeepsOnlyTheLatestValue(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		for index, item := range []string{"first", "second", "third"} {
			if code := postTelemetry(t, env, telemetrySampleInput{
				ObservedAt:    now.Add(-5*time.Minute + time.Duration(index)*time.Minute),
				CurrentItemID: item,
				RendererState: "rendering",
			}).Code; code != http.StatusAccepted {
				t.Fatalf("telemetry status=%d", code)
			}
		}

		var rows int64
		var current string
		if err := env.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM screen_telemetry_snapshots WHERE screen_id=$1`, env.screenID).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(context.Background(),
			`SELECT current_item_id FROM screen_telemetry_snapshots WHERE screen_id=$1`, env.screenID).Scan(&current); err != nil {
			t.Fatal(err)
		}
		// One row per screen, whatever the sample rate. A history here is what
		// turns telemetry into an unbounded table.
		if rows != 1 || current != "third" {
			t.Fatalf("snapshot rows=%d current=%q, want one row holding the latest", rows, current)
		}
	})
}

func TestTelemetrySnapshotIgnoresAnOutOfOrderSample(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		postTelemetry(t, env, telemetrySampleInput{ObservedAt: now, CurrentItemID: "newest"})
		// A retry arriving late must not overwrite newer state with older.
		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt: now.Add(-5 * time.Minute), CurrentItemID: "stale",
		})

		var current string
		if err := env.pool.QueryRow(context.Background(),
			`SELECT current_item_id FROM screen_telemetry_snapshots WHERE screen_id=$1`, env.screenID).Scan(&current); err != nil {
			t.Fatal(err)
		}
		if current != "newest" {
			t.Fatalf("current item = %q, want the newer sample to win", current)
		}
	})
}

// The behaviour the whole threshold design exists for: a measurement that
// oscillates must not produce a stream of events.
func TestFluctuatingMeasurementDoesNotSpamEvents(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		// Cache use bouncing around the 90% line, sampled every ten seconds.
		for index, percent := range []int64{88, 91, 89, 92, 87, 90, 85, 93} {
			postTelemetry(t, env, telemetrySampleInput{
				ObservedAt:      now.Add(-5*time.Minute + time.Duration(index)*10*time.Second),
				CacheUsedBytes:  pointer(percent),
				CacheLimitBytes: pointer(int64(100)),
			})
		}

		entered := telemetryEventCount(t, env, "storage.pressure")
		exited := telemetryEventCount(t, env, "storage.recovered")
		// Values between 80 and 90 sit inside the hysteresis band, so once the
		// condition is entered nothing here clears it.
		if entered != 1 {
			t.Fatalf("storage pressure entered %d times, want 1", entered)
		}
		if exited != 0 {
			t.Fatalf("storage recovered %d times while use never fell below 80%%", exited)
		}
	})
}

func TestConditionRecoversWhenItGenuinelyClears(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt:      now.Add(-30 * time.Minute),
			CacheUsedBytes:  pointer(int64(95)),
			CacheLimitBytes: pointer(int64(100)),
		})
		// Well past the cooldown, and genuinely below the exit level.
		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt:      now,
			CacheUsedBytes:  pointer(int64(40)),
			CacheLimitBytes: pointer(int64(100)),
		})

		if got := telemetryEventCount(t, env, "storage.pressure"); got != 1 {
			t.Fatalf("storage pressure events = %d, want 1", got)
		}
		if got := telemetryEventCount(t, env, "storage.recovered"); got != 1 {
			t.Fatalf("storage recovered events = %d, want 1", got)
		}
		var active bool
		if err := env.pool.QueryRow(context.Background(),
			`SELECT active FROM screen_telemetry_conditions WHERE screen_id=$1 AND condition='storage_pressure'`,
			env.screenID).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if active {
			t.Fatal("the condition is still marked active after recovering")
		}
	})
}

// The cooldown is the second guard: even a value that legitimately crosses the
// full hysteresis band repeatedly is rate-limited.
func TestCooldownSuppressesRapidRepeatTransitions(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		// Latency swinging across the whole band every thirty seconds. The
		// cooldown for latency is ten minutes.
		for index, latency := range []int32{3000, 100, 3000, 100, 3000} {
			postTelemetry(t, env, telemetrySampleInput{
				ObservedAt:        now.Add(-5*time.Minute + time.Duration(index)*30*time.Second),
				ServerRoundTripMS: pointer(latency),
			})
		}

		total := telemetryEventCount(t, env, "network.latency_excessive") +
			telemetryEventCount(t, env, "network.latency_recovered")
		if total != 1 {
			t.Fatalf("emitted %d latency events in two and a half minutes, want 1", total)
		}
	})
}

func TestUnreportedMeasurementsDoNotFireEvents(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		// A player that cannot measure luminance reports nothing for it. That
		// must not read as a black screen.
		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt: time.Now().UTC(), CurrentItemID: "poster",
		})
		if got := telemetryEventCount(t, env, "visual_output.black"); got != 0 {
			t.Fatalf("emitted %d black-output events for a player that reports no luminance", got)
		}
		if got := telemetryEventCount(t, env, "network.latency_excessive"); got != 0 {
			t.Fatalf("emitted %d latency events with no latency reported", got)
		}
	})
}

// A still image legitimately shows identical frames. Only content expected to
// move can be frozen.
func TestFrozenOutputOnlyAppliesWhereMotionIsExpected(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt:              now.Add(-20 * time.Minute),
			PlaybackStallDurationMS: pointer(int64(300_000)),
			ExpectedMotion:          pointer(false),
		})
		if got := telemetryEventCount(t, env, "visual_output.frozen"); got != 0 {
			t.Fatalf("a motionless still image produced %d frozen events", got)
		}

		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt:              now,
			PlaybackStallDurationMS: pointer(int64(300_000)),
			ExpectedMotion:          pointer(true),
		})
		if got := telemetryEventCount(t, env, "visual_output.frozen"); got != 1 {
			t.Fatalf("a frozen video produced %d frozen events, want 1", got)
		}
	})
}

func TestRollupsAggregateIntoFiveMinuteBuckets(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		base := time.Now().UTC().Add(-10 * time.Minute).Truncate(telemetryBucket)
		for index := 0; index < 3; index++ {
			postTelemetry(t, env, telemetrySampleInput{
				ObservedAt:        base.Add(time.Duration(index) * time.Minute),
				ServerRoundTripMS: pointer(int32(100 + index*100)),
				Interval: telemetryIntervalInput{
					Seconds: 60, ConnectedSeconds: 60, HealthyPlaybackSeconds: 55,
					StalledPlaybackSeconds: 5, DownloadedBytes: 1000, CacheHits: 4, CacheMisses: 1,
					DroppedFrames: 2, FrameChangeCount: 30,
					ThermalSeconds: map[string]float64{"nominal": 60},
				},
			})
		}

		var buckets int64
		if err := env.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM screen_telemetry_rollups WHERE screen_id=$1`, env.screenID).Scan(&buckets); err != nil {
			t.Fatal(err)
		}
		// Three samples inside one bucket are one row, not three.
		if buckets != 1 {
			t.Fatalf("rollup rows = %d, want 1", buckets)
		}

		var samples int32
		var averageRTT float32
		var maxRTT int32
		var connected, healthy, stalled int32
		var downloaded, hits, misses, dropped, changes int64
		if err := env.pool.QueryRow(context.Background(), `
			SELECT samples,average_round_trip_ms,max_round_trip_ms,connected_seconds,
			       healthy_playback_seconds,stalled_playback_seconds,downloaded_bytes,
			       cache_hits,cache_misses,dropped_frames,frame_change_count
			FROM screen_telemetry_rollups WHERE screen_id=$1`, env.screenID).Scan(
			&samples, &averageRTT, &maxRTT, &connected, &healthy, &stalled,
			&downloaded, &hits, &misses, &dropped, &changes); err != nil {
			t.Fatal(err)
		}
		if samples != 3 {
			t.Fatalf("samples = %d, want 3", samples)
		}
		// A running mean, so every sample counts equally rather than the last
		// one overwriting the bucket.
		if averageRTT != 200 {
			t.Fatalf("average RTT = %v, want the mean of 100, 200 and 300", averageRTT)
		}
		if maxRTT != 300 {
			t.Fatalf("max RTT = %d, want 300", maxRTT)
		}
		if connected != 180 || healthy != 165 || stalled != 15 {
			t.Fatalf("seconds: connected=%d healthy=%d stalled=%d", connected, healthy, stalled)
		}
		if downloaded != 3000 || hits != 12 || misses != 3 || dropped != 6 || changes != 90 {
			t.Fatalf("counters: bytes=%d hits=%d misses=%d dropped=%d changes=%d",
				downloaded, hits, misses, dropped, changes)
		}
	})
}

func TestRollupsRespectTheirRetentionBound(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		if _, err := env.pool.Exec(ctx,
			`INSERT INTO activity_retention_settings(singleton) VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING`); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx,
			`UPDATE activity_retention_settings SET telemetry_rollup_days=7 WHERE singleton=TRUE`); err != nil {
			t.Fatal(err)
		}
		for _, age := range []string{"1 day", "30 days"} {
			if _, err := env.pool.Exec(ctx, `
				INSERT INTO screen_telemetry_rollups(screen_id,bucket_start,samples)
				VALUES($1,date_trunc('hour',now()-$2::interval),1)`, env.screenID, age); err != nil {
				t.Fatal(err)
			}
		}

		env.server.cleanupActivityBounded(ctx, 500)

		var remaining int64
		if err := env.pool.QueryRow(ctx,
			`SELECT count(*) FROM screen_telemetry_rollups WHERE screen_id=$1`, env.screenID).Scan(&remaining); err != nil {
			t.Fatal(err)
		}
		// Telemetry is bounded storage: the expired bucket is gone.
		if remaining != 1 {
			t.Fatalf("rollups remaining = %d, want only the one inside retention", remaining)
		}
	})
}

func TestTelemetryReportReturnsSnapshotConditionsAndRollups(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt:      now,
			CurrentItemID:   "poster",
			RendererState:   "rendering",
			CacheUsedBytes:  pointer(int64(95)),
			CacheLimitBytes: pointer(int64(100)),
			Interval:        telemetryIntervalInput{Seconds: 60, ConnectedSeconds: 60},
		})

		request := httptest.NewRequest(http.MethodGet,
			"/api/v1/activity/screens/"+env.screenID.String()+"/telemetry?range=24h", nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.screenTelemetry(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("telemetry report status=%d body=%s", response.Code, response.Body.String())
		}
		var envelope struct {
			Data screenTelemetryResponse `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Data.Snapshot == nil || envelope.Data.Snapshot.CurrentItemID != "poster" {
			t.Fatalf("snapshot = %+v", envelope.Data.Snapshot)
		}
		if len(envelope.Data.Rollups) != 1 {
			t.Fatalf("rollups = %d, want 1", len(envelope.Data.Rollups))
		}
		var pressure *telemetryCondition
		for index, condition := range envelope.Data.Conditions {
			if condition.Condition == "storage_pressure" {
				pressure = &envelope.Data.Conditions[index]
			}
		}
		if pressure == nil || !pressure.Active {
			t.Fatalf("conditions = %+v, want an active storage pressure", envelope.Data.Conditions)
		}
	})
}

// A screen that has never reported telemetry is different from one reporting
// zeroes, and the report says so rather than inventing a snapshot.
func TestTelemetryReportOmitsAMissingSnapshot(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		request := httptest.NewRequest(http.MethodGet,
			"/api/v1/activity/screens/"+env.screenID.String()+"/telemetry?range=24h", nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.screenTelemetry(response, request)

		var envelope struct {
			Data screenTelemetryResponse `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Data.Snapshot != nil {
			t.Fatalf("snapshot = %+v, want none for a screen that never reported", envelope.Data.Snapshot)
		}
	})
}

func TestTelemetryRejectsAnImplausibleTimestamp(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		for _, observed := range []time.Time{
			{}, time.Now().UTC().Add(2 * time.Hour), time.Now().UTC().Add(-48 * time.Hour),
		} {
			if code := postTelemetry(t, env, telemetrySampleInput{ObservedAt: observed}).Code; code != http.StatusUnprocessableEntity {
				t.Fatalf("observedAt %v accepted with status %d", observed, code)
			}
		}
	})
}

func TestTelemetryBoundsPlayerSuppliedText(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		long := make([]byte, 4096)
		for index := range long {
			long[index] = 'a'
		}
		postTelemetry(t, env, telemetrySampleInput{
			ObservedAt: time.Now().UTC(),
			// A fingerprint is a short hash; the cap is what stops image data
			// being smuggled into Activity.
			FrameFingerprint: string(long),
			CurrentItemID:    string(long),
		})
		var fingerprint, item string
		if err := env.pool.QueryRow(context.Background(),
			`SELECT frame_fingerprint,current_item_id FROM screen_telemetry_snapshots WHERE screen_id=$1`,
			env.screenID).Scan(&fingerprint, &item); err != nil {
			t.Fatal(err)
		}
		if len(fingerprint) > 64 || len(item) > 128 {
			t.Fatalf("stored text was not bounded: fingerprint=%d item=%d", len(fingerprint), len(item))
		}
	})
}

func TestThermalDistributionRejectsUnknownStates(t *testing.T) {
	clean := sanitizeThermalSeconds(map[string]float64{
		"nominal": 120, "critical": 60,
		// Neither of these is a thermal state; a player cannot grow the object.
		"made_up": 60, "nominal_but_different": 30,
		// Out of range for one bucket.
		"severe": 100_000,
	})
	if len(clean) != 2 || clean["nominal"] != 120 || clean["critical"] != 60 {
		t.Fatalf("thermal distribution = %+v, want only the known in-range states", clean)
	}
}
