package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestMicroPlayClassification(t *testing.T) {
	completed := func(duration int64, reason, result string) playerActivityEventInput {
		return playerActivityEventInput{
			EventType: "content.completed", DurationMS: int64Pointer(duration),
			TerminalReason: reason, Result: result, ContentID: "item", PlaylistItemID: "item",
			SessionType: sessionTypePlaylistItem,
		}
	}
	cases := []struct {
		name  string
		event playerActivityEventInput
		micro bool
		plays bool
	}{
		{"instant boundary", completed(0, terminalExpectedItemBoundary, "completed"), true, false},
		{"one millisecond", completed(1, terminalExpectedItemBoundary, "completed"), true, false},
		{"just under the floor", completed(999, terminalCompletedDuration, "completed"), true, false},
		{"at the floor", completed(1000, terminalExpectedItemBoundary, "completed"), false, true},
		{"a real play", completed(30_000, terminalExpectedItemBoundary, "completed"), false, true},
		// A failure that arrives in 63 ms is exactly what an operator must see.
		{"a fast failure", playerActivityEventInput{EventType: "content.failed", DurationMS: int64Pointer(63), TerminalReason: terminalRendererFailure, Result: "failed", ContentID: "item"}, false, false},
		{"a short play closed by a schedule change", completed(200, terminalScheduleTransition, "partial"), false, false},
		{"an unexplained short partial", completed(200, "", "partial"), false, false},
		{"a short root presentation", playerActivityEventInput{EventType: "presentation.stopped", DurationMS: int64Pointer(10), TerminalReason: terminalExpectedItemBoundary, Result: "completed", SessionType: sessionTypePresentation}, false, false},
		{"no measured duration", playerActivityEventInput{EventType: "content.completed", TerminalReason: terminalExpectedItemBoundary, Result: "completed", ContentID: "item"}, false, false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := isMicroPlay(test.event); got != test.micro {
				t.Errorf("isMicroPlay = %v, want %v", got, test.micro)
			}
			if got := playsSuccessfully(test.event); got != test.plays {
				t.Errorf("playsSuccessfully = %v, want %v", got, test.plays)
			}
		})
	}
}

func TestZeroExpectedDurationIsNormalizedToUnknown(t *testing.T) {
	event := playerActivityEventInput{
		ID: uuid.New(), Sequence: 1, EventType: "content.started",
		OccurredAt: time.Now().UTC(), ExpectedDurationMS: int64Pointer(0),
	}
	if err := normalizePlayerActivity(&event, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if event.ExpectedDurationMS != nil {
		t.Fatalf("expected duration = %d, want none", *event.ExpectedDurationMS)
	}
	real := playerActivityEventInput{
		ID: uuid.New(), Sequence: 2, EventType: "content.started",
		OccurredAt: time.Now().UTC(), ExpectedDurationMS: int64Pointer(10_000),
	}
	if err := normalizePlayerActivity(&real, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if real.ExpectedDurationMS == nil || *real.ExpectedDurationMS != 10_000 {
		t.Fatal("a real expected duration must survive normalization")
	}
}

// One stuck item used to produce tens of thousands of "completed" plays that
// lasted a millisecond. The raw events are evidence of the storm; the derived
// Proof of Play rows are not evidence of anything a viewer saw.
func TestRemountStormIsNotDerivedAsProofOfPlay(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		start := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
		sequence := int64(0)
		next := func(eventType string, at time.Time) playerActivityEventInput {
			sequence++
			return playerActivityEventInput{ID: uuid.New(), Sequence: sequence, EventType: eventType, OccurredAt: at, PlayerTimezone: "UTC"}
		}
		root := next("presentation.started", start)
		root.ActivitySessionID, root.SessionType, root.Result = "root", "presentation", "playing"
		root.PresentationType, root.PresentationID = "playlist", "main"
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{root}}, http.StatusAccepted)

		const storm = 120
		for batch := 0; batch < 3; batch++ {
			events := []playerActivityEventInput{}
			for index := batch * (storm / 3); index < (batch+1)*(storm/3); index++ {
				at := start.Add(time.Duration(index) * 300 * time.Millisecond)
				id := "storm-" + uuid.NewString()
				started := next("content.started", at)
				started.ActivitySessionID, started.ParentSessionID = id, "root"
				started.SessionType, started.ContentType = sessionTypePlaylistItem, "image"
				started.ContentID, started.PlaylistItemID = "item-1", "item-1"
				started.ExpectedDurationMS = int64Pointer(0)
				started.Result = "playing"
				completed := next("content.completed", at.Add(time.Millisecond))
				completed.ActivitySessionID, completed.SessionType = id, sessionTypePlaylistItem
				completed.ContentType, completed.ContentID, completed.PlaylistItemID = "image", "item-1", "item-1"
				completed.Result, completed.TerminalReason = "completed", terminalExpectedItemBoundary
				completed.DurationMS = int64Pointer(1)
				events = append(events, started, completed)
			}
			postActivityBatch(t, env, playerActivityBatchInput{Events: events}, http.StatusAccepted)
		}

		// A genuine play, and a genuine failure that happened to be fast.
		real := next("content.started", start.Add(time.Minute))
		real.ActivitySessionID, real.ParentSessionID, real.SessionType = "real", "root", sessionTypePlaylistItem
		real.ContentType, real.ContentID, real.PlaylistItemID = "image", "item-2", "item-2"
		real.ExpectedDurationMS, real.Result = int64Pointer(10_000), "playing"
		realEnd := next("content.completed", start.Add(time.Minute+10*time.Second))
		realEnd.ActivitySessionID, realEnd.SessionType = "real", sessionTypePlaylistItem
		realEnd.ContentType, realEnd.ContentID, realEnd.PlaylistItemID = "image", "item-2", "item-2"
		realEnd.Result, realEnd.TerminalReason, realEnd.DurationMS = "completed", terminalExpectedItemBoundary, int64Pointer(10_000)
		failed := next("content.failed", start.Add(2*time.Minute))
		failed.ActivitySessionID, failed.SessionType = "fast-failure", sessionTypePlaylistItem
		failed.ContentType, failed.ContentID, failed.PlaylistItemID = "video", "item-3", "item-3"
		failed.Result, failed.TerminalReason, failed.FailureCode = "failed", terminalRendererFailure, "renderer_failure"
		failed.DurationMS = int64Pointer(63)
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{real, realEnd, failed}}, http.StatusAccepted)

		ctx := context.Background()
		var children, roots int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE session_type<>'presentation'), count(*) FILTER (WHERE session_type='presentation') FROM playback_sessions WHERE screen_id=$1`, env.screenID).Scan(&children, &roots); err != nil {
			t.Fatal(err)
		}
		if roots != 1 || children != 2 {
			t.Fatalf("roots=%d children=%d, want the root, the real play and the fast failure only (2 children)", roots, children)
		}
		var expected *int64
		if err := env.pool.QueryRow(ctx, `SELECT expected_duration_ms FROM playback_sessions WHERE screen_id=$1 AND activity_session_id='real'`, env.screenID).Scan(&expected); err != nil || expected == nil || *expected != 10_000 {
			t.Fatalf("real play expected=%v err=%v", expected, err)
		}
		var failures int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE screen_id=$1 AND result='failed' AND activity_session_id='fast-failure'`, env.screenID).Scan(&failures); err != nil || failures != 1 {
			t.Fatalf("fast failure kept=%d err=%v", failures, err)
		}
		// The storm stays diagnosable: every raw event is still in Screen Events.
		var raw int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM player_activity_events WHERE screen_id=$1 AND activity_session_id LIKE 'storm-%'`, env.screenID).Scan(&raw); err != nil || raw != storm*2 {
			t.Fatalf("raw storm events=%d err=%v, want %d", raw, err, storm*2)
		}
		// Zero is stored as unknown, not as a promise to play for zero ms.
		var zeros int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM player_activity_events WHERE screen_id=$1 AND expected_duration_ms=0`, env.screenID).Scan(&zeros); err != nil || zeros != 0 {
			t.Fatalf("zero expected durations stored=%d err=%v", zeros, err)
		}
	})
}

func TestSuccessfulPlayOfTheSameContentRecoversItsIncident(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		start := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
		sequence := int64(0)
		next := func(eventType string, at time.Time) playerActivityEventInput {
			sequence++
			return playerActivityEventInput{ID: uuid.New(), Sequence: sequence, EventType: eventType, OccurredAt: at, PlayerTimezone: "UTC"}
		}
		play := func(content string, at time.Time, duration int64) playerActivityEventInput {
			event := next("content.completed", at)
			event.ActivitySessionID, event.SessionType = "play-"+uuid.NewString(), sessionTypePlaylistItem
			event.ContentType, event.ContentID, event.PlaylistItemID = "video", content, content
			event.Result, event.TerminalReason, event.DurationMS = "completed", terminalExpectedItemBoundary, int64Pointer(duration)
			return event
		}
		failure := next("renderer.failure", start)
		failure.ContentID, failure.FailureCode, failure.Result = "video-1", "renderer_failure", "failed"
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{failure}}, http.StatusAccepted)
		if active := filterIncidents(readIncidents(t, env, ""), incidentPlayback); len(active) != 1 {
			t.Fatalf("a renderer failure produced %d playback incidents, want 1", len(active))
		}

		// Neither a healthy different item nor a sub-second remount of the
		// failing one says the failure is over.
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			play("image-9", start.Add(time.Minute), 10_000),
			play("video-1", start.Add(2*time.Minute), 500),
		}}, http.StatusAccepted)
		if active := filterIncidents(readIncidents(t, env, ""), incidentPlayback); len(active) != 1 {
			t.Fatalf("incident closed by evidence about other content: %d active", len(active))
		}

		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			play("video-1", start.Add(3*time.Minute), 10_000),
		}}, http.StatusAccepted)
		if active := filterIncidents(readIncidents(t, env, ""), incidentPlayback); len(active) != 0 {
			t.Fatalf("the failing content played to a normal end and the incident is still active: %+v", active)
		}
		recovered := filterIncidents(readIncidents(t, env, "?status=recovered"), incidentPlayback)
		if len(recovered) != 1 || recovered[0].RecoveryMode != "automatic" {
			t.Fatalf("recovered incidents = %+v, want one automatic recovery", recovered)
		}
	})
}
