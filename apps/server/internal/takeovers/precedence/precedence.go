// Package precedence is the one rule that decides which Takeover a screen
// shows when several are active on it: the strongest class, then the latest
// activation, then the highest ID. Manifest projection, the screen list, and
// the Takeover API all use these fragments, so they cannot disagree.
//
// It has no dependencies inside the Server, so the playlists, devices,
// takeovers, and HTTP packages can all import it.
package precedence

import (
	"fmt"
	"strings"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// rankSQL maps a class column to its rank, 0 for the strongest. It is built
// from plugin.TakeoverClasses so the SQL and Go orders are one list.
func rankSQL(alias string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "CASE %s.class", alias)
	for rank, class := range plugin.TakeoverClasses {
		fmt.Fprintf(&b, " WHEN '%s' THEN %d", class, rank)
	}
	fmt.Fprintf(&b, " ELSE %d END", len(plugin.TakeoverClasses))
	return b.String()
}

// OrderSQL orders the candidate Takeovers of one screen, effective first.
// alias names the takeovers table.
func OrderSQL(alias string) string {
	return fmt.Sprintf("%s ASC,%s.activated_at DESC,%s.id DESC", rankSQL(alias), alias, alias)
}

// CandidatesSQL is the FROM and WHERE clause of every Takeover that can be
// shown on a screen at a time: active, started, not expired, and not retired
// on that screen. takeover and state alias the takeovers and
// takeover_screen_states tables; screen and at are SQL expressions.
func CandidatesSQL(takeover, state, screen, at string) string {
	return fmt.Sprintf(`FROM takeovers %[1]s JOIN takeover_screen_states %[2]s ON %[2]s.takeover_id=%[1]s.id
		WHERE %[2]s.screen_id=%[3]s AND %[1]s.status='active' AND %[1]s.activated_at<=%[4]s AND %[1]s.expires_at>%[4]s
		AND %[2]s.state NOT IN ('restored','cancelled','expired')`, takeover, state, screen, at)
}

// EffectiveIDSQL is a scalar subquery that answers the ID of the Takeover a
// screen shows at a time, or NULL. It uses its own aliases, so it can sit
// inside a query that already uses e and es.
func EffectiveIDSQL(screen, at string) string {
	return "(SELECT pe.id " + CandidatesSQL("pe", "pes", screen, at) + " ORDER BY " + OrderSQL("pe") + " LIMIT 1)"
}
