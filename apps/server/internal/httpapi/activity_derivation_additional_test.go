package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPlaybackReplacementAndReconnectPreserveOpenSessions(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
		parent := "layout-root-replacement"
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			{ID: uuid.New(), Sequence: 1, EventType: "presentation.started", OccurredAt: now, PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "cafeteria", ActivitySessionID: parent, Result: "playing"},
			{ID: uuid.New(), Sequence: 2, EventType: "playlist_item.started", OccurredAt: now.Add(time.Second), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "cafeteria", ContentType: "media", ContentID: "first", PlaylistItemID: "first-item", LayoutPlacementID: "zone-a", ActivitySessionID: "zone-first", Result: "playing", Metadata: map[string]any{"parentActivitySessionId": parent}},
			{ID: uuid.New(), Sequence: 3, EventType: "playlist_item.started", OccurredAt: now.Add(11 * time.Second), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "cafeteria", ContentType: "media", ContentID: "second", PlaylistItemID: "second-item", LayoutPlacementID: "zone-a", ActivitySessionID: "zone-second", Result: "playing", Metadata: map[string]any{"parentActivitySessionId": parent}},
		}}, http.StatusAccepted)

		var firstResult string
		var firstEnded *time.Time
		if err := env.pool.QueryRow(context.Background(), `SELECT result,ended_at FROM playback_sessions WHERE activity_session_id='zone-first'`).Scan(&firstResult, &firstEnded); err != nil {
			t.Fatal(err)
		}
		if firstResult != "partial" || firstEnded == nil {
			t.Fatalf("replaced child result=%q ended=%v", firstResult, firstEnded)
		}

		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			{ID: uuid.New(), Sequence: 4, EventType: "connection.restored", OccurredAt: now.Add(30 * time.Second), PlayerTimezone: "UTC", Result: "recovered"},
		}}, http.StatusAccepted)

		for _, sessionID := range []string{parent, "zone-second"} {
			var result string
			var ended *time.Time
			if err := env.pool.QueryRow(context.Background(), `SELECT result,ended_at FROM playback_sessions WHERE activity_session_id=$1`, sessionID).Scan(&result, &ended); err != nil {
				t.Fatal(err)
			}
			if result != "playing" || ended != nil {
				t.Fatalf("reconnect changed session %s to result=%q ended=%v", sessionID, result, ended)
			}
		}
	})
}

func TestReconnectPreservesConfirmedPlaybackCompliance(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		start := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Second)
		end := start.Add(time.Hour)
		windowID := insertWindow(t, env, start, end, nil)
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			{ID: uuid.New(), Sequence: 1, EventType: "presentation.started", OccurredAt: start, PlayerTimezone: "UTC", PresentationType: "playlist", PresentationID: "playlist-a", ActivitySessionID: "reconnected-root", Result: "playing"},
			{ID: uuid.New(), Sequence: 2, EventType: "connection.restored", OccurredAt: start.Add(30 * time.Minute), PlayerTimezone: "UTC", Result: "recovered"},
			{ID: uuid.New(), Sequence: 3, EventType: "presentation.stopped", OccurredAt: end, PlayerTimezone: "UTC", PresentationType: "playlist", PresentationID: "playlist-a", ActivitySessionID: "reconnected-root", Result: "completed", TerminalReason: "completed_duration", DurationMS: int64Pointer(time.Hour.Milliseconds())},
		}}, http.StatusAccepted)
		if err := env.server.evaluateExpectedWindows(context.Background(), &env.screenID); err != nil {
			t.Fatal(err)
		}
		status, confirmed := windowStatus(t, env, windowID)
		if status != matchConfirmed || confirmed != time.Hour.Milliseconds() {
			t.Fatalf("reconnect compliance status=%q confirmed=%d", status, confirmed)
		}
	})
}

func TestReconnectRetainsRootWhileMicroPlayIsDiscarded(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		start := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			{ID: uuid.New(), Sequence: 1, EventType: "presentation.started", OccurredAt: start, PlayerTimezone: "UTC", PresentationType: "playlist", PresentationID: "playlist-a", ActivitySessionID: "micro-reconnect-root", Result: "playing"},
			{ID: uuid.New(), Sequence: 2, EventType: "content.started", OccurredAt: start, PlayerTimezone: "UTC", PresentationType: "playlist", PresentationID: "playlist-a", ContentType: "media", ContentID: "image-a", ActivitySessionID: "micro-reconnect-child", ParentSessionID: "micro-reconnect-root", SessionType: "content", Result: "playing"},
			{ID: uuid.New(), Sequence: 3, EventType: "connection.restored", OccurredAt: start.Add(250 * time.Millisecond), PlayerTimezone: "UTC", Result: "recovered"},
			{ID: uuid.New(), Sequence: 4, EventType: "content.completed", OccurredAt: start.Add(500 * time.Millisecond), PlayerTimezone: "UTC", PresentationType: "playlist", PresentationID: "playlist-a", ContentType: "media", ContentID: "image-a", ActivitySessionID: "micro-reconnect-child", Result: "completed", TerminalReason: "expected_item_boundary", DurationMS: int64Pointer(500)},
		}}, http.StatusAccepted)

		var rootCount, childCount, rawCount int
		ctx := context.Background()
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE activity_session_id='micro-reconnect-root' AND ended_at IS NULL AND result='playing'`).Scan(&rootCount); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE activity_session_id='micro-reconnect-child'`).Scan(&childCount); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM player_activity_events WHERE screen_id=$1`, env.screenID).Scan(&rawCount); err != nil {
			t.Fatal(err)
		}
		if rootCount != 1 || childCount != 0 || rawCount != 4 {
			t.Fatalf("root=%d child=%d raw events=%d", rootCount, childCount, rawCount)
		}
	})
}

func TestActivityRetentionPreservesOpenSessions(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		old := time.Now().UTC().Add(-400 * 24 * time.Hour).Truncate(time.Microsecond)
		closedID, openID := uuid.New(), uuid.New()
		if _, err := env.pool.Exec(ctx, `
			INSERT INTO playback_sessions(id,screen_id,activity_session_id,started_at,ended_at,result)
			VALUES($1,$3,'closed-old',$4::timestamptz,$4::timestamptz + interval '1 minute','completed'),
			      ($2,$3,'open-old',$4::timestamptz,NULL,'playing')`, closedID, openID, env.screenID, old); err != nil {
			t.Fatal(err)
		}

		env.server.cleanupActivityBounded(ctx, 100)

		var closedCount, openCount int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE id=$1`, closedID).Scan(&closedCount); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE id=$1 AND ended_at IS NULL`, openID).Scan(&openCount); err != nil {
			t.Fatal(err)
		}
		if closedCount != 0 || openCount != 1 {
			t.Fatalf("closedCount=%d openCount=%d", closedCount, openCount)
		}
	})
}
