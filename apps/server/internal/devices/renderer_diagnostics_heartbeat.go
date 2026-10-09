package devices

import (
	"context"

	"github.com/google/uuid"
)

// updateRendererDiagnosticsHeartbeat stores Edge renderer facts from the
// heartbeat. Best effort and omission-preserving: players that predate the
// fields keep heartbeating, and a screen that stops being an Edge player
// keeps its last known facts rather than failing liveness.
//
// last_renderer_failure and the restart facts are sticky by nature: they
// answer "what was the last failure" even after recovery. safe_mode_reason
// is the exception: leaving safe mode clears it, so the operator stops
// seeing the reason for a state the player is no longer in.
func (s *Service) updateRendererDiagnosticsHeartbeat(ctx context.Context, screenID uuid.UUID, heartbeat Heartbeat) {
	failure := truncateRunes(heartbeat.LastRendererFailure, 64)
	reason := truncateRunes(heartbeat.LastRendererRestartReason, 64)
	safeReason := truncateRunes(heartbeat.SafeModeReason, 240)
	var restarts *int
	if heartbeat.RendererRestartCount != nil && *heartbeat.RendererRestartCount >= 0 {
		restarts = heartbeat.RendererRestartCount
	}
	// A current count, overwritten on every heartbeat that carries it. Out
	// of range (or a downgraded player that omits it) keeps the last known
	// value rather than rejecting the heartbeat.
	var streams *int
	if heartbeat.StreamBackedAssetCount != nil &&
		*heartbeat.StreamBackedAssetCount >= 0 && *heartbeat.StreamBackedAssetCount <= 1024 {
		streams = heartbeat.StreamBackedAssetCount
	}
	safeModeOff := heartbeat.SafeMode != nil && !*heartbeat.SafeMode
	_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET
		last_renderer_failure=COALESCE(NULLIF($2,''),last_renderer_failure),
		renderer_restart_count=COALESCE($3,renderer_restart_count),
		last_renderer_restart_at=COALESCE($4,last_renderer_restart_at),
		last_renderer_restart_reason=COALESCE(NULLIF($5,''),last_renderer_restart_reason),
		safe_mode_reason=CASE WHEN $6 THEN NULL ELSE COALESCE(NULLIF($7,''),safe_mode_reason) END,
		stream_backed_asset_count=COALESCE($8,stream_backed_asset_count)
		WHERE screen_id=$1`,
		screenID, failure, restarts, heartbeat.LastRendererRestartAt, reason, safeModeOff, safeReason, streams)
}
