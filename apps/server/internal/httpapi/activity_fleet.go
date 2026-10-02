package httpapi

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

// Fleet health answers "is this screen doing its job right now", which a
// heartbeat alone cannot. A player can report on time while stuck in safe mode,
// showing a renderer error, or running in the background with nothing on the
// display. Each screen lands in exactly one state so the four counts sum to the
// measured fleet.
const (
	fleetStateHealthy    = "healthy"
	fleetStateImpaired   = "impaired"
	fleetStateOffline    = "offline"
	fleetStateUnmeasured = "unmeasured"
)

// A screen is offline once it passes the same grace period the Screens list
// uses, so the two pages never disagree about who is reachable.
const fleetHeartbeatGrace = devices.OfflineThreshold

// fleetScreenSignals is the current player state one screen reports, read from
// the status authority rather than derived from the event stream.
type fleetScreenSignals struct {
	LastHeartbeatAt *time.Time
	// HasStatus is false when the player has never posted a status document,
	// which is the difference between "playing nothing" and "not yet known".
	HasStatus       bool
	PlaybackState   string
	PlaybackError   string
	SafeMode        bool
	PlaybackDisable bool
	ForegroundState string
	CacheUsedBytes  *int64
	CacheLimitBytes *int64
	ActiveManifest  *int64
	SyncError       string
}

// normalizePlaybackState folds the Android and Linux player vocabularies into
// one set. The two players report the same conditions with different spellings
// ("safe_mode" against "safe-mode", "off_hours" against "sleep"), and Activity
// must not classify the same situation differently by platform.
func normalizePlaybackState(value string) string {
	normalized := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
	switch normalized {
	case "playing":
		return "playing"
	case "safe_mode":
		return "safe_mode"
	case "off_hours", "sleep":
		return "off_hours"
	case "disabled":
		return "disabled"
	case "":
		return ""
	default:
		// starting, pairing, setup, idle, offline_capable and anything a future
		// player adds: reporting, but not confirmation that content is on screen.
		return "idle"
	}
}

// playbackExpected reports whether content should be on the display right now.
// Off hours, an administrative playback stop, and a screen with no assigned
// manifest are all correct states to show nothing in, so they must not be
// counted as impairment.
func playbackExpected(signals fleetScreenSignals) bool {
	if signals.PlaybackDisable || signals.ActiveManifest == nil {
		return false
	}
	switch normalizePlaybackState(signals.PlaybackState) {
	case "off_hours", "disabled":
		return false
	}
	return true
}

func fleetStoragePressure(signals fleetScreenSignals) bool {
	return storagePressure(heartbeatActivityState{
		CacheUsedBytes:  signals.CacheUsedBytes,
		CacheLimitBytes: signals.CacheLimitBytes,
	})
}

// classifyFleetScreen places one screen in exactly one operational state and
// names the reason, which the Activity Overview shows so a count is never an
// unexplained number.
func classifyFleetScreen(now time.Time, signals fleetScreenSignals) (string, string) {
	if signals.LastHeartbeatAt == nil {
		// Enrolled but never heard from: there is nothing to measure yet, and
		// calling that "offline" would blame a screen that may not be installed.
		return fleetStateUnmeasured, "never_reported"
	}
	if now.Sub(signals.LastHeartbeatAt.UTC()) > fleetHeartbeatGrace {
		return fleetStateOffline, "heartbeat_grace_exceeded"
	}
	if !signals.HasStatus {
		return fleetStateUnmeasured, "no_player_status"
	}

	state := normalizePlaybackState(signals.PlaybackState)
	switch {
	case signals.SafeMode || state == "safe_mode":
		return fleetStateImpaired, "safe_mode"
	case signals.PlaybackError != "":
		return fleetStateImpaired, "playback_error"
	case signals.ForegroundState != "" && signals.ForegroundState != "foreground":
		return fleetStateImpaired, "not_in_foreground"
	case fleetStoragePressure(signals):
		return fleetStateImpaired, "storage_pressure"
	case signals.SyncError != "":
		return fleetStateImpaired, "synchronization_error"
	}

	if !playbackExpected(signals) {
		// Correctly showing nothing. There is no playback to confirm, so the
		// screen is reporting normally but cannot be called healthy playback.
		return fleetStateUnmeasured, "playback_not_expected"
	}
	if state != "playing" {
		return fleetStateImpaired, "playback_not_confirmed"
	}
	return fleetStateHealthy, "playing"
}

type activityFleetHealth struct {
	// Measured is the operational population: enabled, paired, not archived,
	// not deleted, and holding a live credential. Screens taken out of service
	// on purpose are excluded so their downtime cannot read as a fault.
	Measured   int64 `json:"measured"`
	Online     int64 `json:"online"`
	Healthy    int64 `json:"healthy"`
	Impaired   int64 `json:"impaired"`
	Offline    int64 `json:"offline"`
	Unmeasured int64 `json:"unmeasured"`
}

// The same population uptime reports on, for the same reason: administrative
// removal is not an outage.
const fleetHealthSQL = `
SELECT s.last_heartbeat_at,
       p.screen_id IS NOT NULL,
       COALESCE(p.playback_state,''),
       COALESCE(p.last_playback_error,''),
       COALESCE(p.safe_mode,FALSE),
       COALESCE(p.playback_disabled,FALSE),
       COALESCE(p.foreground_state,''),
       p.cache_used_bytes,
       p.cache_limit_bytes,
       p.active_manifest_version,
       COALESCE(p.last_sync_error,'')
FROM screens s
LEFT JOIN screen_player_status p ON p.screen_id = s.id
WHERE s.enabled = TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM device_credentials c WHERE c.screen_id = s.id AND c.revoked_at IS NULL)`

func (s *server) fleetHealth(ctx context.Context, now time.Time, scopeUser uuid.UUID, scoped bool) (activityFleetHealth, error) {
	var health activityFleetHealth
	query := fleetHealthSQL
	var args []any
	if scoped {
		query += ` AND ` + devices.InScopeSQL("s", "$1")
		args = append(args, scopeUser)
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return health, err
	}
	defer rows.Close()
	for rows.Next() {
		var signals fleetScreenSignals
		if err := rows.Scan(
			&signals.LastHeartbeatAt, &signals.HasStatus, &signals.PlaybackState,
			&signals.PlaybackError, &signals.SafeMode, &signals.PlaybackDisable,
			&signals.ForegroundState, &signals.CacheUsedBytes, &signals.CacheLimitBytes,
			&signals.ActiveManifest, &signals.SyncError,
		); err != nil {
			return health, err
		}
		health.Measured++
		state, _ := classifyFleetScreen(now, signals)
		switch state {
		case fleetStateHealthy:
			health.Healthy++
		case fleetStateImpaired:
			health.Impaired++
		case fleetStateOffline:
			health.Offline++
		default:
			health.Unmeasured++
		}
		if state != fleetStateOffline && signals.LastHeartbeatAt != nil {
			// Online counts reachability alone, and is reported next to the
			// other states precisely so it is not mistaken for health.
			health.Online++
		}
	}
	if err := rows.Err(); err != nil {
		return health, err
	}
	return health, rows.Err()
}
