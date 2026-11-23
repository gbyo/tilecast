package activityreport

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/keyset"
)

// Fleet health answers "is this screen doing its job right now", which a
// heartbeat alone cannot. A player can report on time while stuck in safe mode,
// showing a renderer error, or running in the background with nothing on the
// display. Each screen lands in exactly one state so the four counts sum to the
// measured fleet.
const (
	FleetHealthy    = "healthy"
	FleetImpaired   = "impaired"
	FleetOffline    = "offline"
	FleetUnmeasured = "unmeasured"
)

// FleetHeartbeatGrace is the grace period after which a screen is offline:
// the same one the Screens list uses, so the two pages never disagree about
// who is reachable.
const FleetHeartbeatGrace = devices.OfflineThreshold

// ScreenSignals is the current player state one screen reports, read from
// the status authority rather than derived from the event stream.
type ScreenSignals struct {
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

// NormalizePlaybackState folds the Android and Linux player vocabularies into
// one set. The two players report the same conditions with different spellings
// ("safe_mode" against "safe-mode", "off_hours" against "sleep"), and Activity
// must not classify the same situation differently by platform.
func NormalizePlaybackState(value string) string {
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

// PlaybackExpected reports whether content should be on the display right now.
// Off hours, an administrative playback stop, and a screen with no assigned
// manifest are all correct states to show nothing in, so they must not be
// counted as impairment.
func PlaybackExpected(signals ScreenSignals) bool {
	if signals.PlaybackDisable || signals.ActiveManifest == nil {
		return false
	}
	switch NormalizePlaybackState(signals.PlaybackState) {
	case "off_hours", "disabled":
		return false
	}
	return true
}

// StoragePressure reports a Player cache at 90 percent of its limit or more.
func StoragePressure(used, limit *int64) bool {
	return used != nil && limit != nil && *limit > 0 && *used*100 >= *limit*90
}

// ClassifyScreen places one screen in exactly one operational state and
// names the reason, which the Activity Overview shows so a count is never an
// unexplained number.
func ClassifyScreen(now time.Time, signals ScreenSignals) (string, string) {
	if signals.LastHeartbeatAt == nil {
		// Enrolled but never heard from: there is nothing to measure yet, and
		// calling that "offline" would blame a screen that may not be installed.
		return FleetUnmeasured, "never_reported"
	}
	if now.Sub(signals.LastHeartbeatAt.UTC()) > FleetHeartbeatGrace {
		return FleetOffline, "heartbeat_grace_exceeded"
	}
	if !signals.HasStatus {
		return FleetUnmeasured, "no_player_status"
	}

	state := NormalizePlaybackState(signals.PlaybackState)
	switch {
	case signals.SafeMode || state == "safe_mode":
		return FleetImpaired, "safe_mode"
	case signals.PlaybackError != "":
		return FleetImpaired, "playback_error"
	case signals.ForegroundState != "" && signals.ForegroundState != "foreground":
		return FleetImpaired, "not_in_foreground"
	case StoragePressure(signals.CacheUsedBytes, signals.CacheLimitBytes):
		return FleetImpaired, "storage_pressure"
	case signals.SyncError != "":
		return FleetImpaired, "synchronization_error"
	}

	if !PlaybackExpected(signals) {
		// Correctly showing nothing. There is no playback to confirm, so the
		// screen is reporting normally but cannot be called healthy playback.
		return FleetUnmeasured, "playback_not_expected"
	}
	if state != "playing" {
		return FleetImpaired, "playback_not_confirmed"
	}
	return FleetHealthy, "playing"
}

// Reachable reports whether a classified screen counts as online: heard from
// and not past the grace period. It is reachability alone, never health.
func Reachable(state string, signals ScreenSignals) bool {
	return state != FleetOffline && signals.LastHeartbeatAt != nil
}

// FleetHealth counts the measured fleet by state.
type FleetHealth struct {
	// Measured is the operational population: enabled, paired, not archived,
	// not deleted, and holding a live credential. Screens taken out of service
	// on purpose are excluded so their downtime cannot read as a fault.
	Measured   int64
	Online     int64
	Healthy    int64
	Impaired   int64
	Offline    int64
	Unmeasured int64
}

// fleetSignalColumns and fleetPopulation are the one read of the measured
// fleet: the same population uptime reports on, for the same reason —
// administrative removal is not an outage.
const fleetSignalColumns = `s.last_heartbeat_at,
       p.screen_id IS NOT NULL,
       COALESCE(p.playback_state,''),
       COALESCE(p.last_playback_error,''),
       COALESCE(p.safe_mode,FALSE),
       COALESCE(p.playback_disabled,FALSE),
       COALESCE(p.foreground_state,''),
       p.cache_used_bytes,
       p.cache_limit_bytes,
       p.active_manifest_version,
       COALESCE(p.last_sync_error,'')`

const fleetFrom = `
FROM screens s
LEFT JOIN screen_player_status p ON p.screen_id = s.id`

const fleetWhere = `
WHERE s.enabled = TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM device_credentials c WHERE c.screen_id = s.id AND c.revoked_at IS NULL)`

const fleetPopulation = fleetFrom + fleetWhere

func signalTargets(signals *ScreenSignals) []any {
	return []any{
		&signals.LastHeartbeatAt, &signals.HasStatus, &signals.PlaybackState,
		&signals.PlaybackError, &signals.SafeMode, &signals.PlaybackDisable,
		&signals.ForegroundState, &signals.CacheUsedBytes, &signals.CacheLimitBytes,
		&signals.ActiveManifest, &signals.SyncError,
	}
}

// FleetHealth classifies every measured screen within access. A nil access
// is the whole installation.
func (r *Reports) FleetHealth(ctx context.Context, now time.Time, access *authz.ScreenAccess) (FleetHealth, error) {
	var health FleetHealth
	query := `SELECT ` + fleetSignalColumns + fleetPopulation
	var args []any
	if access != nil && !access.All {
		query += ` AND ` + access.ScreenSQL("s", "$1")
		args = append(args, access.UserID)
	}
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return health, err
	}
	defer rows.Close()
	for rows.Next() {
		var signals ScreenSignals
		if err := rows.Scan(signalTargets(&signals)...); err != nil {
			return health, err
		}
		health.Measured++
		state, _ := ClassifyScreen(now, signals)
		switch state {
		case FleetHealthy:
			health.Healthy++
		case FleetImpaired:
			health.Impaired++
		case FleetOffline:
			health.Offline++
		default:
			health.Unmeasured++
		}
		if Reachable(state, signals) {
			// Online counts reachability alone, and is reported next to the
			// other states precisely so it is not mistaken for health.
			health.Online++
		}
	}
	return health, rows.Err()
}

// CurrentScreen is what one measured screen is doing now.
type CurrentScreen struct {
	ScreenID   uuid.UUID
	ScreenName string
	CreatedAt  time.Time
	Signals    ScreenSignals
	State      string
	Reason     string
	// Presentation is the newest open root presentation session, and
	// Content the newest open session shown inside it.
	Presentation *OpenSession
	Content      *OpenSession
	// LastHealthyPlayback is when the screen last entered the healthy state.
	LastHealthyPlayback *time.Time
	// LastSuccessfulManifestActivation is the last successful manifest or
	// presentation activation the Player reported.
	LastSuccessfulManifestActivation *time.Time
}

// OpenSession is a playback session that has not ended.
type OpenSession struct {
	Type      string
	ID        string
	Name      string
	StartedAt time.Time
}

// CurrentScreens returns at most limit measured screens within access after
// the position, oldest first by creation, the id as the tie-breaker. A nil
// access is the whole installation.
func (r *Reports) CurrentScreens(ctx context.Context, now time.Time, access *authz.ScreenAccess, after *keyset.After, limit int) ([]CurrentScreen, error) {
	args := []any{}
	where := fleetWhere
	if access != nil && !access.All {
		args = append(args, access.UserID)
		where += ` AND ` + access.ScreenSQL("s", "$"+strconv.Itoa(len(args)))
	}
	where += ` AND ` + keyset.Ascending(after, "s.created_at", "s.id", &args)
	args = append(args, limit)
	rows, err := r.db.Query(ctx, `
		SELECT s.id,s.name,s.created_at,`+fleetSignalColumns+`,
		       root.presentation_type,root.presentation_id,root.name,root.started_at,
		       child.content_type,child.content_id,child.name,child.started_at,
		       (SELECT max(i.started_at) FROM screen_state_intervals i WHERE i.screen_id=s.id AND i.state='healthy'),
		       (SELECT max(e.occurred_at) FROM player_activity_events e WHERE e.screen_id=s.id
		          AND e.event_type IN('manifest.activated','presentation.activated') AND e.result IN('completed','success','playing'))
		`+fleetFrom+`
		LEFT JOIN LATERAL (
			SELECT COALESCE(ps.presentation_type,'') AS presentation_type,COALESCE(ps.presentation_id,'') AS presentation_id,
			       COALESCE(NULLIF(ps.presentation_name,''),pl.name,l.name,'') AS name,ps.started_at
			FROM playback_sessions ps
			LEFT JOIN playlists pl ON ps.presentation_type='playlist' AND ps.presentation_id=pl.id::text
			LEFT JOIN layouts l ON ps.presentation_type='layout' AND ps.presentation_id=l.id::text
			WHERE ps.screen_id=s.id AND ps.ended_at IS NULL AND ps.session_type='presentation'
			ORDER BY ps.started_at DESC,ps.id DESC LIMIT 1) root ON TRUE
		LEFT JOIN LATERAL (
			SELECT COALESCE(ps.content_type,'') AS content_type,COALESCE(ps.content_id,'') AS content_id,
			       COALESCE(NULLIF(ps.content_name,''),a.name,'') AS name,ps.started_at
			FROM playback_sessions ps
			LEFT JOIN assets a ON ps.content_id=a.id::text
			WHERE ps.screen_id=s.id AND ps.ended_at IS NULL AND ps.session_type<>'presentation'
			ORDER BY ps.started_at DESC,ps.id DESC LIMIT 1) child ON TRUE
		`+where+`
		ORDER BY s.created_at,s.id LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CurrentScreen{}
	for rows.Next() {
		var item CurrentScreen
		var rootType, rootID, rootName, childType, childID, childName *string
		var rootStarted, childStarted *time.Time
		targets := append([]any{&item.ScreenID, &item.ScreenName, &item.CreatedAt}, signalTargets(&item.Signals)...)
		targets = append(targets, &rootType, &rootID, &rootName, &rootStarted, &childType, &childID, &childName, &childStarted,
			&item.LastHealthyPlayback, &item.LastSuccessfulManifestActivation)
		if err := rows.Scan(targets...); err != nil {
			return nil, err
		}
		item.State, item.Reason = ClassifyScreen(now, item.Signals)
		if rootStarted != nil {
			item.Presentation = &OpenSession{Type: *rootType, ID: *rootID, Name: *rootName, StartedAt: *rootStarted}
		}
		if childStarted != nil {
			item.Content = &OpenSession{Type: *childType, ID: *childID, Name: *childName, StartedAt: *childStarted}
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
