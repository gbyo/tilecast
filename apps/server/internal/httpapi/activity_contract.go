package httpapi

import (
	"strings"

	"github.com/tilecast/tilecast/apps/server/internal/activityreport"
)

// Activity Event Contract v2. Both players emit this vocabulary; the server
// accepts the v1 names each player used before and maps them here so a fleet
// can be upgraded one player at a time. See docs/activity-event-contract.md.

// The session and terminal-reason vocabulary is owned by activityreport,
// which the Activity reports and the activity.read@1 service share.
const (
	sessionTypePresentation    = activityreport.SessionTypePresentation
	sessionTypeContent         = activityreport.SessionTypeContent
	sessionTypeLayoutPlacement = activityreport.SessionTypeLayoutPlacement
	sessionTypePlaylistItem    = activityreport.SessionTypePlaylistItem
)

const (
	terminalExpectedItemBoundary = activityreport.TerminalExpectedItemBoundary
	terminalCompletedDuration    = activityreport.TerminalCompletedDuration
	terminalScheduleTransition   = activityreport.TerminalScheduleTransition
	terminalManifestReplacement  = activityreport.TerminalManifestReplacement
	terminalDirectAssignment     = activityreport.TerminalDirectAssignment
	terminalTakeover             = activityreport.TerminalTakeover
	terminalPlayerRestart        = activityreport.TerminalPlayerRestart
	terminalProcessExit          = activityreport.TerminalProcessExit
	terminalHeartbeatGap         = activityreport.TerminalHeartbeatGap
	terminalRendererFailure      = activityreport.TerminalRendererFailure
	terminalDecoderFailure       = activityreport.TerminalDecoderFailure
	terminalManualSkip           = activityreport.TerminalManualSkip
	terminalEmptyContent         = activityreport.TerminalEmptyContent
	terminalRecoveryAction       = activityreport.TerminalRecoveryAction
	terminalBoundedTimeout       = activityreport.TerminalBoundedTimeout
	terminalUnknown              = activityreport.TerminalUnknown
)

// minimumPlaybackSessionMS is the shortest a piece of content can be on screen
// and still count as a play. Studio refuses item durations under a second, so
// a child session that ended "as expected" in less than that was not shown: it
// is a Player remounting an item, or a slot a host computed as a millisecond.
// Recording each one as a completed play is how a single stuck item produced
// tens of thousands of zero-length sessions that no viewer ever saw.
const minimumPlaybackSessionMS = 1000

func interruptedTerminalReasons() []string { return activityreport.InterruptedTerminalReasons() }

func canonicalActivityTerminalReason(value string) string {
	return activityreport.CanonicalTerminalReason(value)
}

func isActivityTerminalReason(value string) bool { return activityreport.IsTerminalReason(value) }

func isActivitySessionType(value string) bool { return activityreport.IsSessionType(value) }

// activityEventAliases maps each player's v1 spelling to the contract v2 name.
// Both players kept their own vocabulary for the same condition, which made an
// identical outage derive differently depending on the platform.
var activityEventAliases = map[string]string{
	// Linux v1 names.
	"connection.recovered":  "connection.restored",
	"reliability.safe_mode": "safe_mode.entered",
	"reliability.self_heal": "self_heal.attempted",
	"content.started":       "content.started",
	"content.completed":     "content.completed",
	"content.failed":        "content.failed",
	// Android v1 names for the same child-session boundaries.
	"playlist_item.started":    "content.started",
	"playlist_item.completed":  "content.completed",
	"playlist_item.failed":     "content.failed",
	"playlist_item.skipped":    "content.skipped",
	"media.started":            "content.started",
	"media.completed":          "content.completed",
	"media.failed":             "content.failed",
	"widget.started":           "content.started",
	"widget.completed":         "content.completed",
	"widget.failed":            "content.failed",
	"layout_zone_item.started": "content.started",
	"data_widget.activated":    "content.started",
	// Root presentation boundaries.
	"presentation.activated": "presentation.started",
	"playlist.started":       "presentation.started",
	"layout.activated":       "presentation.started",
	"presentation.completed": "presentation.stopped",
}

// canonicalActivityEventType resolves a reported event name to the contract v2
// name used for derivation. The reported name is still stored verbatim, so the
// Screen Events report keeps showing exactly what the player said.
func canonicalActivityEventType(eventType string) string {
	if canonical, ok := activityEventAliases[eventType]; ok {
		return canonical
	}
	return eventType
}

// contractSessionType derives the session type from the canonical event and the
// identifiers it carries, so a v1 player that cannot report sessionType still
// lands in the right bucket.
func contractSessionType(event playerActivityEventInput) string {
	if isActivitySessionType(event.SessionType) {
		return event.SessionType
	}
	switch canonicalActivityEventType(event.EventType) {
	case "presentation.started", "presentation.stopped", "presentation.failed", "presentation.recovered":
		return sessionTypePresentation
	}
	switch {
	case event.LayoutPlacementID != "":
		return sessionTypeLayoutPlacement
	case event.PlaylistItemID != "":
		return sessionTypePlaylistItem
	case event.ContentID != "" || strings.HasPrefix(canonicalActivityEventType(event.EventType), "content."):
		return sessionTypeContent
	default:
		return sessionTypePresentation
	}
}

// contractTerminalReason resolves the reason a session ended. A player that
// reports one is believed; otherwise the event name is the only evidence, and
// where it says nothing the reason stays unknown rather than being guessed.
func contractTerminalReason(event playerActivityEventInput) string {
	if isActivityTerminalReason(event.TerminalReason) {
		return canonicalActivityTerminalReason(event.TerminalReason)
	}
	switch canonicalActivityEventType(event.EventType) {
	case "content.completed":
		return terminalCompletedDuration
	case "content.skipped":
		return terminalManualSkip
	case "renderer.failure":
		return terminalRendererFailure
	case "decoder.failure":
		return terminalDecoderFailure
	case "presentation.recovered":
		return terminalRecoveryAction
	}
	switch event.FailureCode {
	case "renderer_failure", "playback_error":
		return terminalRendererFailure
	case "decoder_failure":
		return terminalDecoderFailure
	case "heartbeat_gap":
		return terminalHeartbeatGap
	}
	return terminalUnknown
}
