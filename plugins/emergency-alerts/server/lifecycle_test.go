package server_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/plugins/emergency-alerts/server"
)

// alertFeature renders one NWS GeoJSON feature with the given end time as
// both expires and ends.
func alertFeature(id, event, headline string, end time.Time) []byte {
	return []byte(`{"features":[{"id":"` + id + `","properties":{"id":"` + id +
		`","event":"` + event + `","headline":"` + headline +
		`","severity":"Extreme","urgency":"Immediate","areaDesc":"Franklin County",` +
		`"instruction":"Move to an interior room.","senderName":"NWS Wilmington OH",` +
		`"expires":"` + end.UTC().Format(time.RFC3339) + `"}` +
		`,"ends":"` + end.UTC().Format(time.RFC3339) + `"}]}`)
}

func fullscreenRuleInput(playlistID uuid.UUID, screens ...uuid.UUID) server.RuleInput {
	return server.RuleInput{
		Name: "Tornado rule", Enabled: true, EventNames: []string{"Tornado Warning"},
		MinimumSeverity: "Severe", MinimumUrgency: "Expected",
		PlaylistID: &playlistID, MaximumDurationMinutes: 360,
		ScreenIDs: screens,
	}
}

// A custom-playlist fullscreen alert raises one canonical Takeover through
// repeated NWS polls: the second identical poll must not raise another.
func TestAlertTakeoverLifecycle(t *testing.T) {
	h, svc := hostedPlugin(t)
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	h.Install()
	lobby := h.Screen("Lobby")
	seedMonitor(t, h, true, []string{"OH"}, nil)
	playlistID := seedReadyPlaylist(t, h, "Alert playlist")

	rule, err := svc.SaveRule(h.Ctx, uuid.Nil, fullscreenRuleInput(playlistID, lobby), h.OwnerID)
	if err != nil {
		t.Fatal(err)
	}

	end := time.Now().UTC().Add(2 * time.Hour)
	fake.alerts.Store(alertFeature("alert-1", "Tornado Warning", "Take shelter now", end))
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatal(err)
	}
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatal(err)
	}

	var takeoverID uuid.UUID
	if err = h.Pool.QueryRow(h.Ctx, `SELECT takeover_id FROM alert_activations WHERE alert_id='alert-1' AND rule_id=$1 AND cleared_at IS NULL`,
		rule.ID).Scan(&takeoverID); err != nil {
		t.Fatal(err)
	}
	takeoverCount := queryInt(t, h, `SELECT count(*) FROM takeovers WHERE id=$1 AND status='active'`, takeoverID)
	targetCount := queryInt(t, h, `SELECT count(*) FROM takeover_targets WHERE takeover_id=$1 AND screen_id=$2`, takeoverID, lobby)
	stateCount := queryInt(t, h, `SELECT count(*) FROM takeover_screen_states WHERE takeover_id=$1 AND screen_id=$2 AND state='pending'`, takeoverID, lobby)
	activationCount := queryInt(t, h, `SELECT count(*) FROM alert_activations WHERE alert_id='alert-1' AND rule_id=$1`, rule.ID)
	if takeoverCount != 1 || targetCount != 1 || stateCount != 1 || activationCount != 1 {
		t.Fatalf("activation rows takeover=%d target=%d state=%d activation=%d",
			takeoverCount, targetCount, stateCount, activationCount)
	}
	// The activation wrote the rows the Player manifest builder reads: an
	// active takeover, a pending screen state, and a revised manifest. The
	// core Takeover service tests prove those rows project into a manifest;
	// here the revision itself is the contract.
	if version := h.ManifestVersion(lobby); version <= 1 {
		t.Fatalf("activation did not revise the manifest, version=%d", version)
	}

	// Updating a rule that does not exist reports not found.
	if _, err = svc.SaveRule(h.Ctx, uuid.New(), fullscreenRuleInput(playlistID, lobby), h.OwnerID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("updating an unknown rule returned %v, want not found", err)
	}

	// A built-in fullscreen rule provisions a system-managed Data Source,
	// Widget, and Playlist that stay hidden from ordinary authoring lists.
	builtinRule, err := svc.SaveRule(h.Ctx, uuid.Nil, server.RuleInput{
		Name: "Built-in alert", Enabled: true, EventNames: []string{"Tornado Warning"},
		MinimumSeverity: "Severe", MinimumUrgency: "Expected", PresentationMode: "builtin",
		MaximumDurationMinutes: 360, ScreenIDs: []uuid.UUID{lobby},
	}, h.OwnerID)
	if err != nil {
		t.Fatal(err)
	}
	if builtinRule.PresentationMode != "builtin" || builtinRule.PlaylistID == nil ||
		builtinRule.ManagedDataSourceID == nil || builtinRule.ManagedWidgetID == nil ||
		builtinRule.ManagedPlaylistID == nil {
		t.Fatalf("incomplete built-in rule: %#v", builtinRule)
	}
	visiblePlaylists := queryInt(t, h, `SELECT count(*) FROM playlists WHERE deleted_at IS NULL AND system_managed=FALSE`)
	if visiblePlaylists != 1 {
		t.Fatalf("ordinary playlist list includes generated presentation: visible=%d", visiblePlaylists)
	}
	if managed := queryInt(t, h, `SELECT count(*) FROM playlists WHERE id=$1 AND system_managed=TRUE`, builtinRule.ManagedPlaylistID); managed != 1 {
		t.Fatal("built-in playlist is not marked system-managed")
	}

	// A live NWS payload updates the managed Data Source with the alert.
	fake.alerts.Store(alertFeature("alert-builtin", "Tornado Warning", "Tornado observed near Columbus", end))
	versionBeforeBuiltin := h.ManifestVersion(lobby)
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatal(err)
	}
	var cachedPayload string
	if err = h.Pool.QueryRow(h.Ctx, `SELECT cached_payload::text FROM data_source_refresh_states WHERE data_source_id=$1`,
		builtinRule.ManagedDataSourceID).Scan(&cachedPayload); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Tornado observed near Columbus", "Franklin County", "Move to an interior room", "NWS Wilmington OH"} {
		if !strings.Contains(cachedPayload, want) {
			t.Fatalf("built-in cached payload does not contain %q: %s", want, cachedPayload)
		}
	}
	if versionAfterBuiltin := h.ManifestVersion(lobby); versionAfterBuiltin <= versionBeforeBuiltin {
		t.Fatal("built-in activation did not revise the manifest")
	}

	// Clearing the feed cancels only the NWS-created takeover: an unrelated
	// manual Takeover stays active.
	unrelatedID := uuid.New()
	now := time.Now().UTC()
	if _, err = h.Pool.Exec(h.Ctx, `INSERT INTO takeovers(id,organization_id,name,playlist_id,status,activated_at,expires_at)
		VALUES($1,$2,'Manual takeover',$3,'active',$4,$5)`,
		unrelatedID, h.OrgID, playlistID, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fake.alerts.Store([]byte(`{"features":[]}`))
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatal(err)
	}
	if status := queryString(t, h, `SELECT status FROM takeovers WHERE id=$1`, takeoverID); status != "cancelled" {
		t.Fatalf("cleared NWS takeover status=%q, want cancelled", status)
	}
	if status := queryString(t, h, `SELECT status FROM takeovers WHERE id=$1`, unrelatedID); status != "active" {
		t.Fatalf("unrelated takeover status=%q, want active", status)
	}
	if cleared := queryInt(t, h, `SELECT count(*) FROM alert_activations WHERE alert_id='alert-1' AND rule_id=$1 AND cleared_at IS NOT NULL AND clear_reason='no_longer_active'`,
		rule.ID); cleared != 1 {
		t.Fatal("NWS activation was not marked cleared")
	}
}

// Clearing still marks the alert when its takeover is already gone: another
// Takeover may have replaced it, and the canonical cancellation reports
// that as inactive rather than failing the whole poll.
func TestClearMissingToleratesReplacedTakeover(t *testing.T) {
	h, svc := hostedPlugin(t)
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	h.Install()
	lobby := h.Screen("Lobby")
	seedMonitor(t, h, true, []string{"OH"}, nil)
	playlistID := seedReadyPlaylist(t, h, "Alert playlist")
	rule, err := svc.SaveRule(h.Ctx, uuid.Nil, fullscreenRuleInput(playlistID, lobby), h.OwnerID)
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
	// A replacement retires the NWS takeover out from under the activation.
	if _, err = h.Pool.Exec(h.Ctx, `UPDATE takeovers SET status='cancelled',cancelled_at=now() WHERE id=$1`, takeoverID); err != nil {
		t.Fatal(err)
	}
	fake.alerts.Store([]byte(`{"features":[]}`))
	if err = svc.Poll(h.Ctx); err != nil {
		t.Fatalf("clearing past a replaced takeover failed: %v", err)
	}
	if cleared := queryInt(t, h, `SELECT count(*) FROM alert_activations WHERE alert_id='alert-1' AND rule_id=$1 AND cleared_at IS NOT NULL`,
		rule.ID); cleared != 1 {
		t.Fatal("activation past a replaced takeover was not marked cleared")
	}
}
