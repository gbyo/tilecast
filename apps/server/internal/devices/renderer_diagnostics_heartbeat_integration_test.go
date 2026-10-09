package devices

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Edge renderer facts persist from the heartbeat, stay sticky when a later
// heartbeat omits them, and clear safe_mode_reason when the player reports
// it left safe mode.
func TestRendererDiagnosticsHeartbeatPersistsAndClears(t *testing.T) {
	service, pool, principal := airplayHeartbeatTestService(t)
	ctx := context.Background()
	restarts, negative := 7, -3
	streams, tooMany := 2, 2048
	restarted := time.Now().UTC().Add(-5 * time.Minute).Truncate(time.Microsecond)
	safe := true

	service.updateRendererDiagnosticsHeartbeat(ctx, principal.ScreenID, Heartbeat{
		LastRendererFailure:       "rejected",
		RendererRestartCount:      &restarts,
		LastRendererRestartAt:     &restarted,
		LastRendererRestartReason: "recovery",
		SafeMode:                  &safe,
		SafeModeReason:            "renderer recovery exhausted repeatedly",
		StreamBackedAssetCount:    &streams,
	})
	var failure, reason, safeReason *string
	var count, streamCount *int
	var at *time.Time
	if err := pool.QueryRow(ctx, `SELECT last_renderer_failure,renderer_restart_count,last_renderer_restart_at,last_renderer_restart_reason,safe_mode_reason,stream_backed_asset_count FROM screen_player_status WHERE screen_id=$1`, principal.ScreenID).Scan(&failure, &count, &at, &reason, &safeReason, &streamCount); err != nil {
		t.Fatal(err)
	}
	if failure == nil || *failure != "rejected" {
		t.Fatalf("last_renderer_failure = %v", failure)
	}
	if count == nil || *count != 7 {
		t.Fatalf("renderer_restart_count = %v", count)
	}
	if at == nil || !at.Equal(restarted) {
		t.Fatalf("last_renderer_restart_at = %v, want %v", at, restarted)
	}
	if reason == nil || *reason != "recovery" {
		t.Fatalf("last_renderer_restart_reason = %v", reason)
	}
	if safeReason == nil || *safeReason != "renderer recovery exhausted repeatedly" {
		t.Fatalf("safe_mode_reason = %v", safeReason)
	}
	if streamCount == nil || *streamCount != 2 {
		t.Fatalf("stream_backed_asset_count = %v", streamCount)
	}

	// An older player omits the fields: the last known facts survive, and a
	// negative count is dropped rather than stored.
	off := false
	service.updateRendererDiagnosticsHeartbeat(ctx, principal.ScreenID, Heartbeat{
		RendererRestartCount:   &negative,
		StreamBackedAssetCount: &tooMany,
		SafeMode:               &off,
	})
	var failureAfter, reasonAfter, safeReasonAfter *string
	var countAfter, streamCountAfter *int
	if err := pool.QueryRow(ctx, `SELECT last_renderer_failure,renderer_restart_count,last_renderer_restart_reason,safe_mode_reason,stream_backed_asset_count FROM screen_player_status WHERE screen_id=$1`, principal.ScreenID).Scan(&failureAfter, &countAfter, &reasonAfter, &safeReasonAfter, &streamCountAfter); err != nil {
		t.Fatal(err)
	}
	if failureAfter == nil || *failureAfter != "rejected" {
		t.Fatalf("omitted failure cleared the sticky fact: %v", failureAfter)
	}
	if countAfter == nil || *countAfter != 7 {
		t.Fatalf("negative count overwrote the sticky fact: %v", countAfter)
	}
	if streamCountAfter == nil || *streamCountAfter != 2 {
		t.Fatalf("out-of-range stream count overwrote the sticky fact: %v", streamCountAfter)
	}
	if safeReasonAfter != nil {
		t.Fatalf("leaving safe mode kept the reason: %v", safeReasonAfter)
	}

	// Overlong codes truncate by rune instead of failing the heartbeat.
	service.updateRendererDiagnosticsHeartbeat(ctx, principal.ScreenID, Heartbeat{
		LastRendererFailure: strings.Repeat("é", 100),
	})
	var truncated *string
	if err := pool.QueryRow(ctx, `SELECT last_renderer_failure FROM screen_player_status WHERE screen_id=$1`, principal.ScreenID).Scan(&truncated); err != nil {
		t.Fatal(err)
	}
	if truncated == nil || len([]rune(*truncated)) != 64 {
		t.Fatalf("truncated failure has %v runes", truncated)
	}

	// A reported zero overwrites: an activation with no stream-backed
	// videos is known-empty, not unknown.
	none := 0
	service.updateRendererDiagnosticsHeartbeat(ctx, principal.ScreenID, Heartbeat{StreamBackedAssetCount: &none})
	var zero *int
	if err := pool.QueryRow(ctx, `SELECT stream_backed_asset_count FROM screen_player_status WHERE screen_id=$1`, principal.ScreenID).Scan(&zero); err != nil {
		t.Fatal(err)
	}
	if zero == nil || *zero != 0 {
		t.Fatalf("reported zero did not overwrite: %v", zero)
	}
}
