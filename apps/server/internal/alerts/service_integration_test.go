package alerts

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
)

func TestAlertTakeoverLifecycle(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}

	organizationID, userID := uuid.New(), uuid.New()
	screenID, playlistID, assetID, ruleID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Alert Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO plugin_installations(organization_id,plugin_id) VALUES($1,'emergency_alerts')`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','alert-owner','unused-test-hash','owner',TRUE)`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Lobby','android-tv','Test','TV','14','1.0',1920,1080,1,'en-US','UTC')`, screenID, organizationID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id) VALUES($1)`, screenID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id,presentation_schema_versions,native_presentation_capabilities,player_version_code)
		VALUES($1,'{1}',$2::jsonb,33)`, screenID, `{"layout.surface":1,"layout.row":1,"content.badge":1,"content.marquee":1,"binding.core":2}`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by) VALUES($1,$2,'Alert image','image','alert.png','image/png',$3,100,1920,1080,'ready',$4)`, assetID, organizationID, make([]byte, 32), userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible) VALUES($1,$2,'original','local','originals/alert','image/png',100,$3,1920,1080,TRUE)`, uuid.New(), assetID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,created_by) VALUES($1,$2,'Alert playlist',$3)`, playlistID, organizationID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlist_items(id,playlist_id,asset_id,position,duration_ms) VALUES($1,$2,$3,0,10000)`, uuid.New(), playlistID, assetID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO alert_rules(id,organization_id,name,event_names,minimum_severity,minimum_urgency,playlist_id,created_by) VALUES($1,$2,'Tornado rule','{Tornado Warning}','Severe','Expected',$3,$4)`, ruleID, organizationID, playlistID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO alert_rule_targets(rule_id,target_type,screen_id) VALUES($1,'screen',$2)`, ruleID, screenID); err != nil {
		t.Fatal(err)
	}

	deviceService := devices.NewService(pool, devices.NewPresenceHub(), "")
	service := &Service{
		db: pool, devices: deviceService, playlists: playlists.NewService(pool, nil),
		maxDuration: 24 * time.Hour,
	}
	rule := Rule{
		ID: ruleID, PlaylistID: &playlistID, ScreenIDs: []uuid.UUID{screenID},
		MaximumDurationMinutes: 360,
	}
	now := time.Now().UTC().Truncate(time.Second)
	alert := nwsProperties{
		Event: "Tornado Warning", Headline: "Take shelter now",
		Severity: "Extreme", Urgency: "Immediate",
	}
	if err = service.applyAlert(ctx, "alert-1", rule, alert, now); err != nil {
		t.Fatal(err)
	}
	if err = service.applyAlert(ctx, "alert-1", rule, alert, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	var takeoverID uuid.UUID
	var takeoverCount, targetCount, stateCount, activationCount int
	if err = pool.QueryRow(ctx, `SELECT takeover_id FROM alert_activations WHERE alert_id='alert-1' AND rule_id=$1 AND cleared_at IS NULL`, ruleID).Scan(&takeoverID); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM takeovers WHERE id=$1 AND status='active'`, takeoverID).Scan(&takeoverCount); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM takeover_targets WHERE takeover_id=$1 AND screen_id=$2`, takeoverID, screenID).Scan(&targetCount); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM takeover_screen_states WHERE takeover_id=$1 AND screen_id=$2 AND state='pending'`, takeoverID, screenID).Scan(&stateCount); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM alert_activations WHERE alert_id='alert-1' AND rule_id=$1`, ruleID).Scan(&activationCount); err != nil {
		t.Fatal(err)
	}
	if takeoverCount != 1 || targetCount != 1 || stateCount != 1 || activationCount != 1 {
		t.Fatalf("activation rows takeover=%d target=%d state=%d activation=%d", takeoverCount, targetCount, stateCount, activationCount)
	}
	// The activation transaction is followed by the same manifest read used by
	// a reconnecting player. This catches regressions where a durable takeover
	// exists but its playlist graph is not projected into the manifest.
	manifest, _, manifestErr := service.playlists.BuildManifest(ctx, screenID)
	if manifestErr != nil {
		t.Fatalf("build manifest after takeover activation: %v", manifestErr)
	}
	projected := false
	for _, playlist := range manifest.Playlists {
		if playlist.ID == playlistID {
			projected = true
			break
		}
	}
	if manifest.Takeover == nil || manifest.Takeover.ID != takeoverID || !projected {
		t.Fatalf("takeover was not projected after activation: takeover=%#v playlists=%d", manifest.Takeover, len(manifest.Playlists))
	}
	if _, err = service.SaveRule(ctx, uuid.New(), RuleInput{
		Name: "Unknown rule", Enabled: true, EventNames: []string{"Tornado Warning"},
		MinimumSeverity: "Severe", MinimumUrgency: "Expected",
		PlaylistID: &playlistID, MaximumDurationMinutes: 360,
		ScreenIDs: []uuid.UUID{screenID},
	}, userID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("updating an unknown rule returned %v, want not found", err)
	}
	builtinRule, err := service.SaveRule(ctx, uuid.Nil, RuleInput{
		Name: "Built-in alert", Enabled: true, EventNames: []string{"Tornado Warning"},
		MinimumSeverity: "Severe", MinimumUrgency: "Expected", PresentationMode: "builtin",
		MaximumDurationMinutes: 360, ScreenIDs: []uuid.UUID{screenID},
	}, userID)
	if err != nil {
		t.Fatal(err)
	}
	if builtinRule.PresentationMode != "builtin" || builtinRule.PlaylistID == nil ||
		builtinRule.ManagedDataSourceID == nil || builtinRule.ManagedWidgetID == nil ||
		builtinRule.ManagedPlaylistID == nil {
		t.Fatalf("incomplete built-in rule: %#v", builtinRule)
	}
	if listed, listErr := service.playlists.List(ctx, "", 1, 100); listErr != nil {
		t.Fatal(listErr)
	} else if listed.Total != 1 {
		t.Fatalf("ordinary playlist list includes generated presentation: total=%d", listed.Total)
	}
	builtinAlert := nwsProperties{
		Event: "Tornado Warning", Headline: "Tornado observed near Columbus",
		Severity: "Extreme", Urgency: "Immediate", AreaDescription: "Franklin County",
		Instruction: "Move to an interior room.", SenderName: "NWS Wilmington OH",
	}
	if err = service.applyAlert(ctx, "alert-builtin", builtinRule, builtinAlert, now); err != nil {
		t.Fatal(err)
	}
	var cachedPayload string
	if err = pool.QueryRow(ctx, `SELECT cached_payload::text FROM data_source_refresh_states WHERE data_source_id=$1`, builtinRule.ManagedDataSourceID).Scan(&cachedPayload); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Tornado observed near Columbus", "Franklin County", "Move to an interior room", "NWS Wilmington OH"} {
		if !strings.Contains(cachedPayload, want) {
			t.Fatalf("built-in cached payload does not contain %q: %s", want, cachedPayload)
		}
	}

	// A ticker rule answers the same alert without a Takeover: no managed
	// presentation, no playlist, and the bar delivered through the manifest.
	tickerRule, err := service.SaveRule(ctx, uuid.Nil, RuleInput{
		Name: "Ticker alert", Enabled: true, EventNames: []string{"Tornado Warning"},
		MinimumSeverity: "Severe", MinimumUrgency: "Expected", ResponseMode: "ticker",
		TickerDisplayMode: "push", TickerHeightPX: 120, TickerSpeed: "fast",
		MaximumDurationMinutes: 360, ScreenIDs: []uuid.UUID{screenID},
	}, userID)
	if err != nil {
		t.Fatal(err)
	}
	if tickerRule.ResponseMode != "ticker" || tickerRule.PlaylistID != nil ||
		tickerRule.ManagedPlaylistID != nil || tickerRule.TickerHeightPX != 120 {
		t.Fatalf("ticker rule kept fullscreen resources: %#v", tickerRule)
	}
	if _, err = service.SaveRule(ctx, uuid.Nil, RuleInput{
		Name: "Contradiction", Enabled: true, MinimumSeverity: "Severe",
		MinimumUrgency: "Expected", ResponseMode: "ticker", PlaylistID: &playlistID,
		MaximumDurationMinutes: 360, ScreenIDs: []uuid.UUID{screenID},
	}, userID); !errors.Is(err, ErrValidation) {
		t.Fatalf("a ticker rule with a playlist returned %v, want validation", err)
	}
	var tickerVersionBefore int64
	if err = pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screenID).Scan(&tickerVersionBefore); err != nil {
		t.Fatal(err)
	}
	if err = service.applyAlert(ctx, "alert-ticker", tickerRule, builtinAlert, now); err != nil {
		t.Fatal(err)
	}
	var tickerTakeover *uuid.UUID
	var tickerResponse string
	var tickerVersionAfter int64
	if err = pool.QueryRow(ctx, `SELECT takeover_id,response_mode FROM alert_activations WHERE alert_id='alert-ticker' AND rule_id=$1 AND cleared_at IS NULL`,
		tickerRule.ID).Scan(&tickerTakeover, &tickerResponse); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screenID).Scan(&tickerVersionAfter); err != nil {
		t.Fatal(err)
	}
	if tickerTakeover != nil || tickerResponse != "ticker" || tickerVersionAfter <= tickerVersionBefore {
		t.Fatalf("ticker activation takeover=%v response=%q manifest %d->%d",
			tickerTakeover, tickerResponse, tickerVersionBefore, tickerVersionAfter)
	}

	// An office that extends a warning has to reach the bar: the text is
	// unchanged, so only the new end time can revise the manifest.
	extended := builtinAlert
	extendedEnd := now.Add(45 * time.Minute)
	extended.Ends = &extendedEnd
	if err = service.applyAlert(ctx, "alert-ticker", tickerRule, extended, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	var extendedVersion int64
	var storedExpiry time.Time
	if err = pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screenID).Scan(&extendedVersion); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT expires_at FROM alert_activations WHERE alert_id='alert-ticker' AND rule_id=$1`, tickerRule.ID).Scan(&storedExpiry); err != nil {
		t.Fatal(err)
	}
	if extendedVersion <= tickerVersionAfter || !storedExpiry.Equal(extendedEnd) {
		t.Fatalf("extended ticker expiry %s at manifest %d, want %s past %d",
			storedExpiry, extendedVersion, extendedEnd, tickerVersionAfter)
	}
	// Re-polling the same extended alert must not revise anything again, or a
	// bar that reads the same would re-push a manifest every poll.
	if err = service.applyAlert(ctx, "alert-ticker", tickerRule, extended, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var unchangedVersion int64
	if err = pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screenID).Scan(&unchangedVersion); err != nil {
		t.Fatal(err)
	}
	if unchangedVersion != extendedVersion {
		t.Fatalf("unchanged ticker revised the manifest %d->%d", extendedVersion, unchangedVersion)
	}

	unrelatedID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO takeovers(id,organization_id,name,playlist_id,status,activated_at,expires_at) VALUES($1,$2,'Manual takeover',$3,'active',$4,$5)`, unrelatedID, organizationID, playlistID, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = service.clearMissing(ctx, map[string]bool{}, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var createdStatus, unrelatedStatus string
	if err = pool.QueryRow(ctx, `SELECT status FROM takeovers WHERE id=$1`, takeoverID).Scan(&createdStatus); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT status FROM takeovers WHERE id=$1`, unrelatedID).Scan(&unrelatedStatus); err != nil {
		t.Fatal(err)
	}
	if createdStatus != "cancelled" || unrelatedStatus != "active" {
		t.Fatalf("clearMissing statuses created=%q unrelated=%q", createdStatus, unrelatedStatus)
	}
	// A ticker has no Takeover to cancel, so the clear itself and the manifest
	// revision are the only evidence the bar is gone.
	var tickerCleared *time.Time
	var tickerReason string
	var withdrawnVersion int64
	if err = pool.QueryRow(ctx, `SELECT cleared_at,COALESCE(clear_reason,'') FROM alert_activations WHERE alert_id='alert-ticker' AND rule_id=$1`,
		tickerRule.ID).Scan(&tickerCleared, &tickerReason); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screenID).Scan(&withdrawnVersion); err != nil {
		t.Fatal(err)
	}
	if tickerCleared == nil || tickerReason != "no_longer_active" || withdrawnVersion <= extendedVersion {
		t.Fatalf("withdrawn ticker cleared=%v reason=%q manifest %d->%d",
			tickerCleared, tickerReason, extendedVersion, withdrawnVersion)
	}
}
