// Package activityreport owns the Activity reports that more than one
// consumer reads: proof of play, its summary, playback compliance, and the
// current state of each screen. The Studio Activity routes and the
// activity.read@1 service both call it, so the two can never report
// different numbers for the same rows. Metric meanings are defined in
// docs/activity.md; this package implements them and does not redefine them.
package activityreport

// Session types. Only presentation sessions are a screen's wall clock;
// the others are content shown inside it. See docs/activity-event-contract.md.
const (
	SessionTypePresentation    = "presentation"
	SessionTypeContent         = "content"
	SessionTypeLayoutPlacement = "layout_placement"
	SessionTypePlaylistItem    = "playlist_item"
)

// Terminal reasons say why a session ended. The distinction that matters is
// whether the ending was expected: a schedule transition and a decoder failure
// both end playback early, but only one of them is an interruption.
const (
	TerminalExpectedItemBoundary = "expected_item_boundary"
	TerminalCompletedDuration    = "completed_duration"
	TerminalScheduleTransition   = "schedule_transition"
	TerminalManifestReplacement  = "manifest_replacement"
	TerminalDirectAssignment     = "direct_assignment_change"
	TerminalTakeover             = "takeover"
	TerminalPlayerRestart        = "player_restart"
	TerminalProcessExit          = "process_exit"
	TerminalHeartbeatGap         = "heartbeat_gap"
	TerminalRendererFailure      = "renderer_failure"
	TerminalDecoderFailure       = "decoder_failure"
	TerminalManualSkip           = "manual_skip"
	TerminalEmptyContent         = "empty_content"
	TerminalRecoveryAction       = "recovery_action"
	TerminalBoundedTimeout       = "bounded_timeout"
	TerminalUnknown              = "unknown"
)

// TerminalUnexpected is the filter value that selects every reason the
// Interrupted plays metric counts.
const TerminalUnexpected = "unexpected"

var terminalReasons = []string{
	TerminalExpectedItemBoundary, TerminalCompletedDuration, TerminalScheduleTransition,
	TerminalManifestReplacement, TerminalDirectAssignment, TerminalTakeover,
	TerminalPlayerRestart, TerminalProcessExit, TerminalHeartbeatGap, TerminalRendererFailure,
	TerminalDecoderFailure, TerminalManualSkip, TerminalEmptyContent, TerminalRecoveryAction, TerminalBoundedTimeout,
	TerminalUnknown,
}

// expectedTerminalReasons end a session for a reason an operator asked for or
// that is simply how playback works. They are not interruptions even though the
// session did not run to its expected duration.
var expectedTerminalReasons = map[string]bool{
	TerminalExpectedItemBoundary: true,
	TerminalCompletedDuration:    true,
	TerminalScheduleTransition:   true,
	TerminalManifestReplacement:  true,
	TerminalDirectAssignment:     true,
	TerminalTakeover:             true,
	TerminalManualSkip:           true,
	TerminalEmptyContent:         true,
}

// InterruptedTerminalReasons is the complement, minus `unknown`. An unknown
// reason is not evidence of an interruption, so it is excluded rather than
// assumed: counting it would inflate the metric with every legacy record.
func InterruptedTerminalReasons() []string {
	reasons := make([]string, 0, len(terminalReasons))
	for _, reason := range terminalReasons {
		if reason == TerminalUnknown || expectedTerminalReasons[reason] {
			continue
		}
		reasons = append(reasons, reason)
	}
	return reasons
}

// terminalReasonAliases maps the pre-rename spelling to the canonical one. A
// Player built before "emergency takeover" became "takeover" still ends
// sessions with the old reason, and rejecting it would drop those sessions into
// `unknown` — which is deliberately excluded from the interruption metric, so
// the loss would be silent rather than visible.
var terminalReasonAliases = map[string]string{
	"emergency_takeover": TerminalTakeover,
}

// CanonicalTerminalReason resolves an alias to the canonical reason.
func CanonicalTerminalReason(value string) string {
	if canonical, ok := terminalReasonAliases[value]; ok {
		return canonical
	}
	return value
}

// IsTerminalReason reports whether value is a reason or an alias of one.
func IsTerminalReason(value string) bool {
	for _, reason := range terminalReasons {
		if CanonicalTerminalReason(value) == reason {
			return true
		}
	}
	return false
}

// IsSessionType reports whether value is a session type.
func IsSessionType(value string) bool {
	switch value {
	case SessionTypePresentation, SessionTypeContent, SessionTypeLayoutPlacement, SessionTypePlaylistItem:
		return true
	default:
		return false
	}
}

// Session results, the values playback_sessions.result holds.
var sessionResults = map[string]bool{
	"playing": true, "completed": true, "partial": true, "skipped": true, "failed": true, "unknown": true, "recovered": true,
}

// IsSessionResult reports whether value is a session result.
func IsSessionResult(value string) bool { return sessionResults[value] }
