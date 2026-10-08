package httpapi

import (
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

func healthTime(now time.Time, age time.Duration) *time.Time {
	at := now.Add(-age)
	return &at
}

func TestDerivePlayerHealth(t *testing.T) {
	now := time.Now().UTC()
	contact := healthTime(now, time.Minute)
	telemetryAt := healthTime(now, 2*time.Minute)
	progress := healthTime(now, 3*time.Minute)
	zero, two := 0, 2
	yes := true

	for _, testCase := range []struct {
		name          string
		input         playerHealthInput
		state, cause  string
		observedFresh bool
	}{
		{
			name: "healthy playback needs progress evidence, not just a socket",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState: "playing", LastHealthyPlaybackAt: progress,
				TelemetryObservedAt: telemetryAt, TelemetryRendererState: "healthy",
				TelemetryLastProgressAt: progress,
			},
			state: playerHealthHealthy, observedFresh: true,
		},
		{
			name: "a disconnected screen is disconnected even with old healthy telemetry",
			input: playerHealthInput{
				Status: devices.StatusOffline, LastContactAt: healthTime(now, time.Hour),
				PlaybackState: "playing", LastHealthyPlaybackAt: healthTime(now, time.Hour),
				TelemetryObservedAt: healthTime(now, time.Hour), TelemetryRendererState: "healthy",
			},
			state: playerHealthDisconnected, cause: "connection_lost",
		},
		{
			name:  "never-contacted screen",
			input: playerHealthInput{Status: devices.StatusOffline},
			state: playerHealthDisconnected, cause: "never_contacted",
		},
		{
			name: "online but renderer failed",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState: "playing", LastRendererFailure: "rejected",
				TelemetryObservedAt: telemetryAt, TelemetryRendererState: "disconnected",
			},
			state: playerHealthRendererDown, cause: "renderer_disconnected",
		},
		{
			name: "renderer failure without fresh progress is unavailable, not healthy",
			input: playerHealthInput{
				Status: devices.StatusRecent, LastContactAt: contact,
				PlaybackState: "playing", LastRendererFailure: "rejected",
				TelemetryObservedAt: telemetryAt, TelemetryRendererState: "healthy",
			},
			state: playerHealthRendererDown, cause: "renderer_failure",
		},
		{
			name: "renderer waiting for evidence",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState:       "starting",
				TelemetryObservedAt: telemetryAt, TelemetryRendererState: "waiting_for_progress",
			},
			state: playerHealthWaitingEvidence, cause: "awaiting_playback_evidence",
		},
		{
			name: "playing without progress waits for evidence",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact, PlaybackState: "playing",
			},
			state: playerHealthWaitingEvidence, cause: "awaiting_playback_evidence",
		},
		{
			name: "recovery in progress",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState: "playing", RecoveryLevel: &two,
				LastRendererRestartAt: healthTime(now, 5*time.Minute), LastRendererRestartReason: "recovery",
				TelemetryObservedAt: telemetryAt, TelemetryRendererState: "starting",
			},
			state: playerHealthRecovering, cause: "recovery_in_progress",
		},
		{
			name: "safe mode with reason",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState: "safe-mode", SafeMode: true,
				SafeModeReason: "renderer recovery exhausted repeatedly",
			},
			state: playerHealthSafeMode, cause: "renderer recovery exhausted repeatedly",
		},
		{
			name: "stale telemetry is not renderer evidence",
			input: playerHealthInput{
				Status: devices.StatusRecent, LastContactAt: contact,
				PlaybackState:       "playing",
				TelemetryObservedAt: healthTime(now, time.Hour), TelemetryRendererState: "healthy",
				TelemetryLastProgressAt: healthTime(now, time.Hour),
			},
			state: playerHealthWaitingEvidence, cause: "awaiting_playback_evidence",
		},
		{
			name: "failed preparation",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState: "starting", LastSyncError: "oversize_asset",
			},
			state: playerHealthPresentationFail, cause: "preparation_failed",
		},
		{
			name: "incompatible presentation",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState:       "starting",
				TelemetryObservedAt: telemetryAt, TelemetryRendererState: "incompatible",
			},
			state: playerHealthPresentationFail, cause: "presentation_incompatible",
		},
		{
			name: "update failure needs intervention",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState: "playing", LastHealthyPlaybackAt: progress,
				UpdateState: "failed", UpdateError: "verify_failed",
			},
			state: playerHealthNeedsIntervention, cause: "update_failed",
		},
		{
			name: "intentional sleep stays quiet",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact, PlaybackState: "sleep",
			},
			state: playerHealthSleepingDisabled, cause: "display_sleep",
		},
		{
			name: "disabled playback stays quiet",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState: "disabled", PlaybackDisabled: &yes,
			},
			state: playerHealthSleepingDisabled, cause: "playback_disabled",
		},
		{
			name: "legacy player without renderer fields and idle is healthy",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact, PlaybackState: "idle",
			},
			state: playerHealthHealthy,
		},
		{
			name: "legacy playing player with fresh heartbeat health is healthy",
			input: playerHealthInput{
				Status: devices.StatusRecent, LastContactAt: contact,
				PlaybackState: "playing", LastHealthyPlaybackAt: progress,
			},
			state: playerHealthHealthy,
		},
		{
			name: "escalation step zero is not recovery",
			input: playerHealthInput{
				Status: devices.StatusOnline, LastContactAt: contact,
				PlaybackState: "playing", LastHealthyPlaybackAt: progress, RecoveryLevel: &zero,
			},
			state: playerHealthHealthy,
		},
		{
			name:  "unreported player is unknown",
			input: playerHealthInput{Status: devices.StatusRecent, LastContactAt: contact},
			state: playerHealthUnknown, cause: "unreported",
		},
		{
			name:  "disabled screen",
			input: playerHealthInput{Status: devices.StatusDisabled, LastContactAt: contact},
			state: playerHealthSleepingDisabled, cause: "screen_disabled",
		},
		{
			name:  "revoked screen",
			input: playerHealthInput{Status: devices.StatusRevoked, LastContactAt: contact},
			state: playerHealthDisconnected, cause: "credential_revoked",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			health := derivePlayerHealth(now, testCase.input)
			if health.State != testCase.state || health.Cause != testCase.cause {
				t.Fatalf("state=%q cause=%q, want state=%q cause=%q",
					health.State, health.Cause, testCase.state, testCase.cause)
			}
			if testCase.observedFresh && (health.ObservedAt == nil || now.Sub(*health.ObservedAt) > playerHealthFreshness) {
				t.Fatalf("observedAt=%v, want a fresh observation", health.ObservedAt)
			}
		})
	}
}

func TestDerivePlayerHealthReportsLastRecoveryAction(t *testing.T) {
	now := time.Now().UTC()
	two := 2
	restarted := healthTime(now, 5*time.Minute)
	health := derivePlayerHealth(now, playerHealthInput{
		Status: devices.StatusOnline, LastContactAt: healthTime(now, time.Minute),
		PlaybackState: "playing", RecoveryLevel: &two,
		LastRendererRestartAt: restarted, LastRendererRestartReason: "recovery",
		TelemetryObservedAt: healthTime(now, 2*time.Minute), TelemetryRendererState: "starting",
	})
	if health.State != playerHealthRecovering {
		t.Fatalf("state=%q, want %q", health.State, playerHealthRecovering)
	}
	if health.LastRecoveryReason != "recovery" || !health.LastRecoveryAt.Equal(*restarted) {
		t.Fatalf("recovery=%q at %v, want recovery at %v",
			health.LastRecoveryReason, health.LastRecoveryAt, restarted)
	}
	if health.RecoveryLevel == nil || *health.RecoveryLevel != 2 {
		t.Fatalf("recoveryLevel=%v, want 2", health.RecoveryLevel)
	}
}
