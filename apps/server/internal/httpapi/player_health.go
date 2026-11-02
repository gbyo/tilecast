package httpapi

import (
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

// Player health states. One accurately derived presentation of a screen's
// condition, from existing authoritative signals: connection state, the
// player-status row, and the telemetry snapshot. Renderer health is never
// inferred from socket connectivity alone: a connected screen with no
// playback evidence is waiting or failed, never healthy.
const (
	playerHealthDisconnected      = "disconnected"
	playerHealthHealthy           = "healthy"
	playerHealthRendererDown      = "renderer_unavailable"
	playerHealthWaitingEvidence   = "waiting_for_evidence"
	playerHealthRecovering        = "recovering"
	playerHealthSafeMode          = "safe_mode"
	playerHealthSleepingDisabled  = "sleeping_or_disabled"
	playerHealthPresentationFail  = "presentation_failed"
	playerHealthNeedsIntervention = "needs_intervention"
	playerHealthUnknown           = "unknown"
)

// playerHealthFreshness bounds how old an observation may be before it stops
// describing the screen. Past it, the screen is disconnected or unknown —
// an old healthy sample must never make a stalled screen look healthy.
const playerHealthFreshness = 15 * time.Minute

// playerHealthInput carries the already-loaded signals derivePlayerHealth
// needs. Empty and nil mean unreported, which is different from reported
// zero: legacy players omit every Edge-specific field.
type playerHealthInput struct {
	Status        devices.Status
	LastContactAt *time.Time

	PlaybackState             string
	PlaybackDisabled          *bool
	SafeMode                  bool
	SafeModeReason            string
	RecoveryLevel             *int
	StreamBackedAssetCount    *int
	LastRendererFailure       string
	LastRendererRestartAt     *time.Time
	LastRendererRestartReason string
	LastHealthyPlaybackAt     *time.Time
	LastSyncError             string
	UpdateState               string
	UpdateError               string

	TelemetryObservedAt     *time.Time
	TelemetryRendererState  string
	TelemetryLastProgressAt *time.Time
}

type playerHealth struct {
	State          string     `json:"state"`
	ObservedAt     *time.Time `json:"observedAt,omitempty"`
	Cause          string     `json:"cause,omitempty"`
	RendererState  string     `json:"rendererState,omitempty"`
	LastProgressAt *time.Time `json:"lastProgressAt,omitempty"`
	// Last relevant recovery action: the restart reason and time the
	// player reported, plus the ladder position when escalated.
	LastRecoveryReason string     `json:"lastRecoveryReason,omitempty"`
	LastRecoveryAt     *time.Time `json:"lastRecoveryAt,omitempty"`
	RecoveryLevel      *int       `json:"recoveryLevel,omitempty"`
	// Stream-backed videos in the current activation: content without a
	// complete local copy. Nil is unreported (legacy players).
	StreamBackedAssetCount *int `json:"streamBackedAssetCount,omitempty"`
	// Update and rollback facts, present only when relevant.
	UpdateState string `json:"updateState,omitempty"`
	UpdateError string `json:"updateError,omitempty"`
}

func derivePlayerHealth(now time.Time, input playerHealthInput) playerHealth {
	health := playerHealth{}
	telemetryFresh := input.TelemetryObservedAt != nil && now.Sub(*input.TelemetryObservedAt) <= playerHealthFreshness
	rendererState := ""
	if telemetryFresh {
		rendererState = input.TelemetryRendererState
	}
	health.RendererState = rendererState
	progressAt := latestHealthTime(input.LastHealthyPlaybackAt, input.TelemetryLastProgressAt)
	if progressAt != nil && now.Sub(*progressAt) <= playerHealthFreshness {
		health.LastProgressAt = progressAt
	}
	health.ObservedAt = latestHealthTime(input.LastContactAt, input.TelemetryObservedAt, progressAt)
	health.StreamBackedAssetCount = input.StreamBackedAssetCount

	switch input.Status {
	case devices.StatusDisabled:
		health.State, health.Cause = playerHealthSleepingDisabled, "screen_disabled"
		return health
	case devices.StatusRevoked:
		health.State, health.Cause = playerHealthDisconnected, "credential_revoked"
		return health
	case devices.StatusAwaitingPlayer:
		health.State, health.Cause = playerHealthUnknown, "awaiting_player"
		return health
	case devices.StatusOffline:
		health.State = playerHealthDisconnected
		if input.LastContactAt == nil {
			health.Cause = "never_contacted"
		} else {
			health.Cause = "connection_lost"
		}
		return health
	}

	if input.SafeMode {
		health.State = playerHealthSafeMode
		health.Cause = input.SafeModeReason
		if health.Cause == "" {
			health.Cause = "recovery"
		}
		health.setRecovery(input)
		return health
	}

	if input.UpdateError != "" || input.UpdateState == "failed" {
		health.State, health.Cause = playerHealthNeedsIntervention, "update_failed"
		health.UpdateState, health.UpdateError = input.UpdateState, input.UpdateError
		return health
	}

	if input.LastSyncError != "" || rendererState == "incompatible" {
		health.State, health.Cause = playerHealthPresentationFail, "preparation_failed"
		if rendererState == "incompatible" {
			health.Cause = "presentation_incompatible"
		}
		return health
	}

	if input.RecoveryLevel != nil && *input.RecoveryLevel > 0 {
		health.State, health.Cause = playerHealthRecovering, "recovery_in_progress"
		health.setRecovery(input)
		return health
	}

	switch rendererState {
	case "disconnected":
		health.State, health.Cause = playerHealthRendererDown, "renderer_disconnected"
		return health
	case "starting", "waiting_for_progress":
		health.State, health.Cause = playerHealthWaitingEvidence, "awaiting_playback_evidence"
		return health
	}
	if (input.PlaybackDisabled != nil && *input.PlaybackDisabled) || input.PlaybackState == "disabled" {
		health.State, health.Cause = playerHealthSleepingDisabled, "playback_disabled"
		return health
	}
	if input.PlaybackState == "sleep" {
		health.State, health.Cause = playerHealthSleepingDisabled, "display_sleep"
		return health
	}
	if input.LastRendererFailure != "" && health.LastProgressAt == nil && input.PlaybackState != "idle" {
		health.State, health.Cause = playerHealthRendererDown, "renderer_failure"
		health.setRecovery(input)
		return health
	}

	switch input.PlaybackState {
	case "playing":
		if health.LastProgressAt != nil {
			health.State = playerHealthHealthy
			return health
		}
		health.State, health.Cause = playerHealthWaitingEvidence, "awaiting_playback_evidence"
		return health
	case "idle":
		// Nothing assigned and nothing broken: healthy idle stays quiet.
		health.State = playerHealthHealthy
		return health
	case "setup", "pairing", "":
		health.State, health.Cause = playerHealthUnknown, "unreported"
		if input.PlaybackState != "" {
			health.Cause = "player_setup"
		}
		return health
	default:
		// starting, unavailable, safe-mode (without the flag), and anything
		// future: connected but no evidence either way.
		health.State, health.Cause = playerHealthWaitingEvidence, "awaiting_playback_evidence"
		return health
	}
}

func (h *playerHealth) setRecovery(input playerHealthInput) {
	h.LastRecoveryReason = input.LastRendererRestartReason
	h.LastRecoveryAt = input.LastRendererRestartAt
	h.RecoveryLevel = input.RecoveryLevel
}

func latestHealthTime(values ...*time.Time) *time.Time {
	var latest *time.Time
	for _, value := range values {
		if value != nil && (latest == nil || value.After(*latest)) {
			latest = value
		}
	}
	return latest
}
