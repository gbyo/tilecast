package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

func (s *Service) applyAlert(ctx context.Context, alertID string, rule Rule, alert nwsProperties, now time.Time) error {
	alertID = bounded(alertID, 2048)
	alert.Event = bounded(alert.Event, 200)
	alert.Headline = bounded(alert.Headline, 1000)
	alert.Description = bounded(alert.Description, 8000)
	alert.Instruction = bounded(alert.Instruction, 4000)
	alert.Severity = bounded(alert.Severity, 32)
	alert.Urgency = bounded(alert.Urgency, 32)
	alert.Certainty = bounded(alert.Certainty, 32)
	alert.AreaDescription = bounded(alert.AreaDescription, 2000)
	alert.SenderName = bounded(alert.SenderName, 500)
	// A rule read from the database always states its response mode; one built in
	// memory by an older caller may not, and a takeover is what it meant.
	responseMode := rule.ResponseMode
	if responseMode == "" {
		responseMode = "takeover"
	}
	ticker := responseMode == "ticker"
	var existing *uuid.UUID
	var shown displayedAlert
	err := s.db.QueryRow(ctx, `SELECT takeover_id,event,headline,area_description,instruction,severity,expires_at FROM alert_activations WHERE alert_id=$1 AND rule_id=$2 AND cleared_at IS NULL`,
		alertID, rule.ID).Scan(&existing, &shown.event, &shown.headline, &shown.areaDescription, &shown.instruction, &shown.severity, &shown.expiresAt)
	if err == nil {
		tx, beginErr := s.db.Begin(ctx)
		if beginErr != nil {
			return beginErr
		}
		defer tx.Rollback(ctx)
		expires := alertExpiry(alert, now, rule.MaximumDurationMinutes)
		_, err = tx.Exec(ctx, `UPDATE alert_activations SET event=$3,headline=$4,description=$5,instruction=$6,severity=$7,urgency=$8,certainty=$9,area_description=$10,sender=$11,effective_at=$12,expires_at=$13,last_seen_at=$14
			WHERE alert_id=$1 AND rule_id=$2`, alertID, rule.ID, alert.Event, alert.Headline, alert.Description, alert.Instruction, alert.Severity, alert.Urgency, alert.Certainty, alert.AreaDescription, alert.SenderName, alert.Effective, alertExpiry(alert, now, rule.MaximumDurationMinutes), now)
		if err != nil {
			return err
		}
		changed, updateErr := s.updateBuiltinAlertData(ctx, tx, rule, alert, expires, now)
		if updateErr != nil {
			return updateErr
		}
		callbacks := []plugin.AfterCommit{}
		// A bar carries the alert text and its expiry in the manifest itself, so
		// either only reaches the screen through a new manifest.
		if ticker && shown.differsFrom(alert, expires) {
			_, callback, bumpErr := s.bumpRuleScreens(ctx, tx, rule.ID, "nws.alert.updated")
			err = bumpErr
			if err != nil {
				return err
			}
			callbacks = append(callbacks, callback)
		}
		if changed && existing != nil {
			callback, refreshErr := s.host.Takeovers.RefreshInTx(ctx, tx, *existing, "nws.alert.updated")
			if refreshErr != nil {
				return refreshErr
			}
			callbacks = append(callbacks, callback)
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		for _, callback := range callbacks {
			callback()
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// A takeover cannot be raised without content to raise. A ticker has its
	// content in the manifest, so it has nothing to be missing.
	if !ticker && rule.PlaylistID == nil {
		return nil
	}
	expires := alertExpiry(alert, now, rule.MaximumDurationMinutes)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = s.updateBuiltinAlertData(ctx, tx, rule, alert, expires, now); err != nil {
		return err
	}
	var takeoverID *uuid.UUID
	var screenIDs []uuid.UUID
	var afterCommit plugin.AfterCommit
	if ticker {
		// The bar reaches the screen the same way a Countdown Bar does: a bumped
		// manifest, which the plugin channel then projects the activation into.
		// Nothing is taken over, so there is nothing to restore afterwards.
		if screenIDs, afterCommit, err = s.bumpRuleScreens(ctx, tx, rule.ID, "nws.ticker.activated"); err != nil {
			return err
		}
		if len(screenIDs) == 0 {
			return fmt.Errorf("alert rule has no eligible screens")
		}
		if err = s.host.Audit.RecordInTx(ctx, tx, plugin.AuditEvent{Action: "nws_alert_ticker.activated", ResourceType: "nws_alert_rule", ResourceID: rule.ID.String(), Metadata: map[string]any{"alertId": alertID, "event": alert.Event}}); err != nil {
			return err
		}
	} else {
		raised, takeoverScreens, callback, activateErr := s.activate(ctx, tx, rule, alert.Event, alert.Headline, alert.Description, now, expires)
		if activateErr != nil {
			return activateErr
		}
		takeoverID, screenIDs = &raised, takeoverScreens
		afterCommit = callback
	}
	_, err = tx.Exec(ctx, `INSERT INTO alert_activations(alert_id,rule_id,event,headline,description,instruction,severity,urgency,certainty,area_description,sender,effective_at,expires_at,response_mode,takeover_id,first_seen_at,last_seen_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
		ON CONFLICT(alert_id,rule_id) DO UPDATE SET event=EXCLUDED.event,headline=EXCLUDED.headline,description=EXCLUDED.description,instruction=EXCLUDED.instruction,severity=EXCLUDED.severity,urgency=EXCLUDED.urgency,certainty=EXCLUDED.certainty,area_description=EXCLUDED.area_description,sender=EXCLUDED.sender,effective_at=EXCLUDED.effective_at,expires_at=EXCLUDED.expires_at,response_mode=EXCLUDED.response_mode,takeover_id=EXCLUDED.takeover_id,last_seen_at=EXCLUDED.last_seen_at,cleared_at=NULL,clear_reason=NULL`,
		alertID, rule.ID, alert.Event, alert.Headline, alert.Description, alert.Instruction, alert.Severity, alert.Urgency, alert.Certainty, alert.AreaDescription, alert.SenderName, alert.Effective, expires, responseMode, takeoverID, now)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if afterCommit != nil {
		afterCommit()
	}
	return nil
}

// displayedAlert is what an activation is currently putting on screen. A ticker
// publishes it in the manifest, so it is compared against the freshly polled
// alert to decide whether a new manifest is owed.
type displayedAlert struct {
	event           string
	headline        string
	areaDescription string
	instruction     string
	severity        string
	expiresAt       *time.Time
}

// differsFrom reports whether the polled alert would put anything new on screen.
//
// The expiry counts, because it is what a Player offline on a cached manifest
// uses to take the bar down: a warning the office extends has to reach the
// screen, not wait for the wording to change. It is compared only when the
// stored expiry is the publisher's own end — when the rule ceiling supplied it
// instead, the value is `now + maximum duration`, recomputed on every poll, and
// comparing that would re-push a manifest a minute for a bar that reads the same.
func (d displayedAlert) differsFrom(alert nwsProperties, expires time.Time) bool {
	if d.event != alert.Event || d.headline != alert.Headline ||
		d.areaDescription != alert.AreaDescription || d.instruction != alert.Instruction ||
		d.severity != alert.Severity {
		return true
	}
	end := alertEnd(alert)
	if end == nil || !expires.Equal(*end) {
		return false
	}
	return d.expiresAt == nil || !d.expiresAt.Equal(expires)
}

func ruleTargetsInTx(ctx context.Context, tx pgx.Tx, ruleID uuid.UUID) (plugin.ScreenTargets, error) {
	var targets plugin.ScreenTargets
	err := tx.QueryRow(ctx, `SELECT COALESCE(array_agg(screen_id) FILTER (WHERE screen_id IS NOT NULL),'{}'), COALESCE(array_agg(screen_group_id) FILTER (WHERE screen_group_id IS NOT NULL),'{}') FROM alert_rule_targets WHERE rule_id=$1`, ruleID).Scan(&targets.ScreenIDs, &targets.GroupIDs)
	return targets, err
}

func (s *Service) bumpRuleScreens(ctx context.Context, tx pgx.Tx, ruleID uuid.UUID, reason string) ([]uuid.UUID, plugin.AfterCommit, error) {
	targets, err := ruleTargetsInTx(ctx, tx, ruleID)
	if err != nil {
		return nil, nil, err
	}
	screens, err := s.host.Targets.ResolveScreensInTx(ctx, tx, targets)
	if err != nil {
		return nil, nil, err
	}
	afterCommit, err := s.host.Manifests.InvalidateScreensInTx(ctx, tx, screens, reason)
	return screens, afterCommit, err
}

func (s *Service) ruleScreenIDs(ctx context.Context, ruleID uuid.UUID) ([]uuid.UUID, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	targets, err := ruleTargetsInTx(ctx, tx, ruleID)
	if err != nil {
		return nil, err
	}
	return s.host.Targets.ResolveScreensInTx(ctx, tx, targets)
}

func (s *Service) bumpScreens(ctx context.Context, screenIDs []uuid.UUID, reason string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	afterCommit, err := s.host.Manifests.InvalidateScreensInTx(ctx, tx, screenIDs, reason)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	afterCommit()
	return nil
}

func (s *Service) refreshRuleScreens(ctx context.Context, ruleID uuid.UUID, reason string) error {
	screenIDs, err := s.ruleScreenIDs(ctx, ruleID)
	if err != nil {
		return err
	}
	return s.bumpScreens(ctx, screenIDs, reason)
}

// clearRuleActivations ends every live activation of one rule, whichever way it
// was answering: a takeover is cancelled and restored, a bar is withdrawn by
// republishing the manifest without it.
func (s *Service) clearRuleActivations(ctx context.Context, ruleID uuid.UUID, reason string) error {
	rows, err := s.db.Query(ctx, `SELECT alert_id,takeover_id FROM alert_activations WHERE rule_id=$1 AND cleared_at IS NULL`, ruleID)
	if err != nil {
		return err
	}
	type live struct {
		alertID    string
		takeoverID *uuid.UUID
	}
	items := []live{}
	for rows.Next() {
		var item live
		if err = rows.Scan(&item.alertID, &item.takeoverID); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	if len(items) == 0 {
		return nil
	}
	now := time.Now().UTC()
	withoutTakeover := false
	for _, item := range items {
		if item.takeoverID == nil {
			withoutTakeover = true
			continue
		}
		if err = s.cancelTakeover(ctx, *item.takeoverID, now); err != nil {
			return err
		}
	}
	if _, err = s.db.Exec(ctx, `UPDATE alert_activations SET cleared_at=$2,clear_reason=$3 WHERE rule_id=$1 AND cleared_at IS NULL`, ruleID, now, reason); err != nil {
		return err
	}
	if withoutTakeover {
		return s.refreshRuleScreens(ctx, ruleID, "nws.ticker.cleared")
	}
	return nil
}

func builtinAlertDocuments(alert nwsProperties, expires, updatedAt time.Time) (string, string) {
	messageParts := []string{}
	for _, value := range []string{alert.Event, alert.Headline, alert.AreaDescription, alert.Instruction} {
		value = strings.TrimSpace(value)
		if value != "" {
			messageParts = append(messageParts, value)
		}
	}
	message := strings.Join(messageParts, " — ")
	if message == "" {
		message = "Waiting for an active NWS alert"
	}
	expiresAt := ""
	if !expires.IsZero() {
		expiresAt = expires.UTC().Format(time.RFC3339)
	}
	configuration := map[string]any{
		"message": message, "severity": alert.Severity, "instructions": alert.Instruction,
		"contact": alert.SenderName, "expiresAt": expiresAt,
	}
	configJSON, _ := json.Marshal(configuration)
	fields := []map[string]string{
		{"key": "message", "label": "Message", "type": "text"},
		{"key": "severity", "label": "Severity", "type": "text"},
		{"key": "instructions", "label": "Instructions", "type": "text"},
		{"key": "contact", "label": "Contact", "type": "text"},
		{"key": "expiresAt", "label": "Expiration time", "type": "datetime"},
		{"key": "updatedAt", "label": "Updated time", "type": "datetime"},
	}
	values := map[string]string{
		"message": message, "severity": alert.Severity, "instructions": alert.Instruction,
		"contact": alert.SenderName, "expiresAt": expiresAt,
		"updatedAt": updatedAt.UTC().Format(time.RFC3339),
	}
	payload := map[string]any{"datasets": []any{map[string]any{
		"id": "object", "kind": "object", "fields": fields, "values": values,
		"cachedAt": updatedAt.UTC(), "staleAt": expires.UTC(),
	}}}
	payloadJSON, _ := json.Marshal(payload)
	return string(configJSON), string(payloadJSON)
}

func (s *Service) updateBuiltinAlertData(
	ctx context.Context,
	tx pgx.Tx,
	rule Rule,
	alert nwsProperties,
	expires, now time.Time,
) (bool, error) {
	// A ticker rule keeps no managed presentation even though it reads as
	// `builtin`: its text lives in the manifest, so there is no Data Source to
	// keep in step. Rules that once answered fullscreen may still carry managed
	// resource identifiers, and writing to them would be updating a snapshot
	// nothing is showing.
	if rule.ResponseMode == "ticker" || rule.PresentationMode != "builtin" || rule.ManagedDataSourceID == nil {
		return false, nil
	}
	configuration, payload := builtinAlertDocuments(alert, expires, now)
	return s.host.ManagedPresentations.UpdateDataInTx(ctx, tx, *rule.ManagedDataSourceID, configuration, payload, "nws", expires)
}

func bounded(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	for limit > 0 && !utf8.ValidString(value[:limit]) {
		limit--
	}
	return value[:limit]
}

// alertEnd is the end the publisher stated, if any. `ends` is the authoritative
// one when both are present.
func alertEnd(alert nwsProperties) *time.Time {
	if alert.Ends != nil {
		return alert.Ends
	}
	return alert.Expires
}

func alertExpiry(alert nwsProperties, now time.Time, maxMinutes int) time.Time {
	maximum := now.Add(time.Duration(maxMinutes) * time.Minute)
	candidate := alertEnd(alert)
	if candidate == nil || !candidate.After(now) || candidate.After(maximum) {
		return maximum
	}
	return *candidate
}

func (s *Service) activate(ctx context.Context, tx pgx.Tx, rule Rule, event, headline, description string, now, expires time.Time) (uuid.UUID, []uuid.UUID, plugin.AfterCommit, error) {
	if rule.PlaylistID == nil {
		return uuid.Nil, nil, nil, fmt.Errorf("alert rule has no takeover playlist")
	}
	name := event
	if name == "" {
		name = "NWS alert"
	}
	detail := headline
	if detail == "" {
		detail = description
	}
	result, afterCommit, err := s.host.Takeovers.ActivateInTx(ctx, tx, plugin.TakeoverRequest{
		Name: name, Description: bounded(detail, 2000), PlaylistID: *rule.PlaylistID,
		Targets:     plugin.ScreenTargets{ScreenIDs: rule.ScreenIDs, GroupIDs: rule.GroupIDs},
		ActivatedAt: now, ExpiresAt: expires, AuditAction: "takeover.activated_by_nws",
		AuditMetadata: map[string]any{"ruleId": rule.ID.String(), "event": event},
	})
	if err != nil {
		return uuid.Nil, nil, nil, err
	}
	return result.ID, result.ScreenIDs, afterCommit, nil
}

func (s *Service) clearMissing(ctx context.Context, seen map[string]bool, now time.Time) error {
	rows, err := s.db.Query(ctx, `SELECT alert_id,rule_id,takeover_id FROM alert_activations WHERE cleared_at IS NULL`)
	if err != nil {
		return err
	}
	type missing struct {
		alertID    string
		ruleID     uuid.UUID
		takeoverID *uuid.UUID
	}
	items := []missing{}
	for rows.Next() {
		var item missing
		if err = rows.Scan(&item.alertID, &item.ruleID, &item.takeoverID); err != nil {
			rows.Close()
			return err
		}
		if !seen[item.alertID+"\x00"+item.ruleID.String()] {
			items = append(items, item)
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, item := range items {
		if item.takeoverID != nil {
			if err = s.cancelTakeover(ctx, *item.takeoverID, now); err != nil {
				return err
			}
		}
		_, err = s.db.Exec(ctx, `UPDATE alert_activations SET cleared_at=$3,clear_reason='no_longer_active' WHERE alert_id=$1 AND rule_id=$2 AND cleared_at IS NULL`, item.alertID, item.ruleID, now)
		if err != nil {
			return err
		}
		// A cleared bar is only gone once the screens are handed a manifest that
		// no longer contains it. A cancelled takeover already republishes.
		if item.takeoverID == nil {
			if err = s.refreshRuleScreens(ctx, item.ruleID, "nws.ticker.cleared"); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) cancelTakeover(ctx context.Context, takeoverID uuid.UUID, _ time.Time) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	afterCommit, err := s.host.Takeovers.CancelInTx(ctx, tx, takeoverID, uuid.Nil, "NWS alert is no longer active")
	if errors.Is(err, plugin.ErrTakeoverInactive) {
		// Another Takeover already replaced this one. The alert still has to
		// be marked cleared below; the takeover end state already holds.
		return nil
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	afterCommit()
	return nil
}
