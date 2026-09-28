package server_test

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/plugins/emergency-alerts/server"
)

func tickerRuleInput(screens ...uuid.UUID) server.RuleInput {
	return server.RuleInput{
		Name: "Ticker alert", Enabled: true, EventNames: []string{"Tornado Warning"},
		MinimumSeverity: "Severe", MinimumUrgency: "Expected", ResponseMode: "ticker",
		TickerDisplayMode: "push", TickerHeightPX: 120, TickerSpeed: "fast",
		MaximumDurationMinutes: 360, ScreenIDs: screens,
	}
}

// A ticker rule answers without a Takeover: no managed presentation, no
// playlist, and the bar delivered through the manifest. Only a changed
// display revises the manifest again.
func TestTickerLifecycle(t *testing.T) {
	h, svc := hostedPlugin(t)
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	h.Install()
	lobby := h.Screen("Lobby")
	seedMonitor(t, h, true, []string{"OH"}, nil)
	playlistID := seedReadyPlaylist(t, h, "Alert playlist")

	rule, err := svc.SaveRule(h.Ctx, uuid.Nil, tickerRuleInput(lobby), h.OwnerID)
	if err != nil {
		t.Fatal(err)
	}
	if rule.ResponseMode != "ticker" || rule.PlaylistID != nil ||
		rule.ManagedPlaylistID != nil || rule.ManagedDataSourceID != nil || rule.TickerHeightPX != 120 {
		t.Fatalf("ticker rule kept fullscreen resources: %#v", rule)
	}
	if _, err = svc.SaveRule(h.Ctx, uuid.Nil, server.RuleInput{
		Name: "Contradiction", Enabled: true, MinimumSeverity: "Severe",
		MinimumUrgency: "Expected", ResponseMode: "ticker", PlaylistID: &playlistID,
		MaximumDurationMinutes: 360, ScreenIDs: []uuid.UUID{lobby},
	}, h.OwnerID); !errors.Is(err, server.ErrValidation) {
		t.Fatalf("a ticker rule with a playlist returned %v, want validation", err)
	}

	versionBefore := h.ManifestVersion(lobby)
	// Truncated to the second: ends round-trip through RFC3339, which
	// carries no sub-second precision.
	firstEnd := time.Now().UTC().Truncate(time.Second).Add(time.Hour)
	fake.alerts.Store(alertFeature("alert-ticker", "Tornado Warning", "Tornado observed near Columbus", firstEnd))
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatal(err)
	}
	var tickerTakeover *uuid.UUID
	var tickerResponse string
	if err = h.Pool.QueryRow(h.Ctx, `SELECT takeover_id,response_mode FROM alert_activations WHERE alert_id='alert-ticker' AND rule_id=$1 AND cleared_at IS NULL`,
		rule.ID).Scan(&tickerTakeover, &tickerResponse); err != nil {
		t.Fatal(err)
	}
	versionAfter := h.ManifestVersion(lobby)
	if tickerTakeover != nil || tickerResponse != "ticker" || versionAfter <= versionBefore {
		t.Fatalf("ticker activation takeover=%v response=%q manifest %d->%d",
			tickerTakeover, tickerResponse, versionBefore, versionAfter)
	}
	projected := false
	for _, entry := range h.Manifest(lobby) {
		if entry.Type == "alert_ticker" {
			projected = true
		}
	}
	if !projected {
		t.Fatalf("ticker activation not projected into the manifest: %#v", h.Manifest(lobby))
	}

	// An office that extends a warning has to reach the bar: the text is
	// unchanged, so only the new end time can revise the manifest.
	extendedEnd := firstEnd.Add(45 * time.Minute)
	fake.alerts.Store(alertFeature("alert-ticker", "Tornado Warning", "Tornado observed near Columbus", extendedEnd))
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatal(err)
	}
	extendedVersion := h.ManifestVersion(lobby)
	var storedExpiry time.Time
	if err = h.Pool.QueryRow(h.Ctx, `SELECT expires_at FROM alert_activations WHERE alert_id='alert-ticker' AND rule_id=$1`,
		rule.ID).Scan(&storedExpiry); err != nil {
		t.Fatal(err)
	}
	if extendedVersion <= versionAfter || !storedExpiry.Equal(extendedEnd) {
		t.Fatalf("extended ticker expiry %s at manifest %d, want %s past %d",
			storedExpiry, extendedVersion, extendedEnd, versionAfter)
	}
	// Re-polling the same extended alert must not revise anything again, or a
	// bar that reads the same would re-push a manifest every poll.
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatal(err)
	}
	if unchanged := h.ManifestVersion(lobby); unchanged != extendedVersion {
		t.Fatalf("unchanged ticker revised the manifest %d->%d", extendedVersion, unchanged)
	}

	// A ticker has no Takeover to cancel, so the clear itself and the manifest
	// revision are the only evidence the bar is gone.
	fake.alerts.Store([]byte(`{"features":[]}`))
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatal(err)
	}
	var tickerCleared *time.Time
	var tickerReason string
	if err = h.Pool.QueryRow(h.Ctx, `SELECT cleared_at,COALESCE(clear_reason,'') FROM alert_activations WHERE alert_id='alert-ticker' AND rule_id=$1`,
		rule.ID).Scan(&tickerCleared, &tickerReason); err != nil {
		t.Fatal(err)
	}
	withdrawnVersion := h.ManifestVersion(lobby)
	if tickerCleared == nil || tickerReason != "no_longer_active" || withdrawnVersion <= extendedVersion {
		t.Fatalf("withdrawn ticker cleared=%v reason=%q manifest %d->%d",
			tickerCleared, tickerReason, extendedVersion, withdrawnVersion)
	}
	for _, entry := range h.Manifest(lobby) {
		if entry.Type == "alert_ticker" {
			t.Fatal("cleared ticker still projected into the manifest")
		}
	}
}

// One rule may target a screen directly and through a Display Group at once.
// An overlapping screen is answered once, not once per target.
func TestMixedScreenAndGroupTargets(t *testing.T) {
	h, svc := hostedPlugin(t)
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	h.Install()
	lobby := h.Screen("Lobby")
	cafe := h.Screen("Cafeteria")
	group := h.SyncGroup("Downstairs", lobby, cafe)
	seedMonitor(t, h, true, []string{"OH"}, nil)
	playlistID := seedReadyPlaylist(t, h, "Alert playlist")

	rule, err := svc.SaveRule(h.Ctx, uuid.Nil, server.RuleInput{
		Name: "Mixed targets", Enabled: true, EventNames: []string{"Tornado Warning"},
		MinimumSeverity: "Severe", MinimumUrgency: "Expected",
		PlaylistID: &playlistID, MaximumDurationMinutes: 360,
		ScreenIDs: []uuid.UUID{lobby}, GroupIDs: []uuid.UUID{group},
	}, h.OwnerID)
	if err != nil {
		t.Fatal(err)
	}
	fake.alerts.Store(alertFeature("alert-1", "Tornado Warning", "Take shelter now", time.Now().UTC().Add(2*time.Hour)))
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatal(err)
	}
	var takeoverID uuid.UUID
	if err = h.Pool.QueryRow(h.Ctx, `SELECT takeover_id FROM alert_activations WHERE alert_id='alert-1' AND rule_id=$1 AND cleared_at IS NULL`,
		rule.ID).Scan(&takeoverID); err != nil {
		t.Fatal(err)
	}
	// The Takeover records both targets as declared.
	if n := queryInt(t, h, `SELECT count(*) FROM takeover_targets WHERE takeover_id=$1 AND target_type='screen' AND screen_id=$2`,
		takeoverID, lobby); n != 1 {
		t.Fatalf("direct screen target rows=%d, want 1", n)
	}
	if n := queryInt(t, h, `SELECT count(*) FROM takeover_targets WHERE takeover_id=$1 AND target_type='group' AND screen_group_id=$2`,
		takeoverID, group); n != 1 {
		t.Fatalf("group target rows=%d, want 1", n)
	}
	// The overlapping screen resolves once despite matching both targets.
	states := queryInt(t, h, `SELECT count(*) FROM takeover_screen_states WHERE takeover_id=$1 AND state='pending'`, takeoverID)
	lobbyStates := queryInt(t, h, `SELECT count(*) FROM takeover_screen_states WHERE takeover_id=$1 AND screen_id=$2 AND state='pending'`, takeoverID, lobby)
	cafeStates := queryInt(t, h, `SELECT count(*) FROM takeover_screen_states WHERE takeover_id=$1 AND screen_id=$2 AND state='pending'`, takeoverID, cafe)
	if states != 2 || lobbyStates != 1 || cafeStates != 1 {
		t.Fatalf("effective screens total=%d lobby=%d cafe=%d, want 2/1/1", states, lobbyStates, cafeStates)
	}
	// The ticker projection follows the same resolution for group members.
	for _, screen := range []uuid.UUID{lobby, cafe} {
		if version := h.ManifestVersion(screen); version <= 1 {
			t.Fatalf("mixed-target activation did not revise screen %s, version=%d", screen, version)
		}
	}
}
