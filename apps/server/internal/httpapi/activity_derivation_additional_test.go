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
