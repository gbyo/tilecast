package httpapi

import "strings"

// Activity Event Contract v2. Both players emit this vocabulary; the server
// accepts the v1 names each player used before and maps them here so a fleet
// can be upgraded one player at a time. See docs/activity-event-contract.md.

const (
	sessionTypePresentation    = "presentation"
	sessionTypeContent         = "content"
	sessionTypeLayoutPlacement = "layout_placement"
	sessionTypePlaylistItem    = "playlist_item"
)

// Terminal reasons say why a session ended. The distinction that matters is
// whether the ending was expected: a schedule transition and a decoder failure
// both end playback early, but only one of them is an interruption.
const (
	terminalExpectedItemBoundary = "expected_item_boundary"
	terminalCompletedDuration    = "completed_duration"
	terminalScheduleTransition   = "schedule_transition"
	terminalManifestReplacement  = "manifest_replacement"
	terminalDirectAssignment     = "direct_assignment_change"
	terminalTakeover             = "takeover"
	terminalPlayerRestart        = "player_restart"
	terminalProcessExit          = "process_exit"
	terminalHeartbeatGap         = "heartbeat_gap"
	terminalRendererFailure      = "renderer_failure"
	terminalDecoderFailure       = "decoder_failure"
	terminalManualSkip           = "manual_skip"
	terminalEmptyContent         = "empty_content"
	terminalRecoveryAction       = "recovery_action"
	terminalBoundedTimeout       = "bounded_timeout"
	terminalUnknown              = "unknown"
)

// minimumPlaybackSessionMS is the shortest a piece of content can be on screen
// and still count as a play. Studio refuses item durations under a second, so
// a child session that ended "as expected" in less than that was not shown: it
// is a Player remounting an item, or a slot a host computed as a millisecond.
// Recording each one as a completed play is how a single stuck item produced
// tens of thousands of zero-length sessions that no viewer ever saw.
const minimumPlaybackSessionMS = 1000

var activityTerminalReasons = []string{
	terminalExpectedItemBoundary, terminalCompletedDuration, terminalScheduleTransition,
	terminalManifestReplacement, terminalDirectAssignment, terminalTakeover,
	terminalPlayerRestart, terminalProcessExit, terminalHeartbeatGap, terminalRendererFailure,
	terminalDecoderFailure, terminalManualSkip, terminalEmptyContent, terminalRecoveryAction, terminalBoundedTimeout,
	terminalUnknown,
}

// expectedTerminalReasons end a session for a reason an operator asked for or
// that is simply how playback works. They are not interruptions even though the
// session did not run to its expected duration.
var expectedTerminalReasons = map[string]bool{
	terminalExpectedItemBoundary: true,
	terminalCompletedDuration:    true,
	terminalScheduleTransition:   true,
	terminalManifestReplacement:  true,
	terminalDirectAssignment:     true,
	terminalTakeover:             true,
	terminalManualSkip:           true,
	terminalEmptyContent:         true,
}

// interruptedTerminalReasons is the complement, minus `unknown`. An unknown
// reason is not evidence of an interruption, so it is excluded rather than
// assumed: counting it would inflate the metric with every legacy record.
func interruptedTerminalReasons() []string {
	reasons := make([]string, 0, len(activityTerminalReasons))
	for _, reason := range activityTerminalReasons {
		if reason == terminalUnknown || expectedTerminalReasons[reason] {
			continue
		}
		reasons = append(reasons, reason)
	}
	return reasons
}

// activityTerminalReasonAliases maps the pre-rename spelling to the canonical
// one. A Player built before "emergency takeover" became "takeover" still ends
// sessions with the old reason, and rejecting it would drop those sessions into
// `unknown` — which is deliberately excluded from the interruption metric, so
// the loss would be silent rather than visible.
var activityTerminalReasonAliases = map[string]string{
	"emergency_takeover": terminalTakeover,
}

func canonicalActivityTerminalReason(value string) string {
	if canonical, ok := activityTerminalReasonAliases[value]; ok {
		return canonical
	}
	return value
}

func isActivityTerminalReason(value string) bool {
	for _, reason := range activityTerminalReasons {
		if canonicalActivityTerminalReason(value) == reason {
			return true
		}
	}
	return false
}

func isActivitySessionType(value string) bool {
	switch value {
	case sessionTypePresentation, sessionTypeContent, sessionTypeLayoutPlacement, sessionTypePlaylistItem:
		return true
	default:
		return false
	}
}

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
