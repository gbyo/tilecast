package contenthealth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/coreevents"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Plugin Content Health checks (docs/plugin-providers.md). A check is the
// contenthealth.checks provider slot: core passes one changed item of a
// declared kind, the plugin returns named conditions, and core owns the
// incidents. The built-in sweeps above do not change.
//
// Changed-item detection does not trust updated_at columns. Core builds the
// item's read-only model, encodes it as canonical JSON, and compares its
// SHA-256 with the fingerprint of the last check that completed. A failed
// check keeps the earlier fingerprint and the earlier conditions, so it
// never makes a condition recover, and the item is checked again later.

// PluginCheck is one installed, declared check.
type PluginCheck struct {
	PluginID string
	CheckID  string
	Title    string
	Kinds    []string
}

// PluginChecks is the plugin host's side of the slot.
type PluginChecks interface {
	// ContentChecks lists the checks of installed plugins.
	ContentChecks(ctx context.Context) ([]PluginCheck, error)
	// RunContentCheck runs one check on one item. It validates the result
	// and returns a CheckFailure for any failure of the plugin.
	RunContentCheck(ctx context.Context, pluginID, checkID string, item plugin.ContentItem) ([]plugin.Condition, error)
}

// ContentModels lists content and builds its models.
type ContentModels interface {
	IDs(ctx context.Context, kind string) ([]uuid.UUID, error)
	Model(ctx context.Context, kind string, id uuid.UUID) (plugin.ContentItem, error)
}

// Model errors. A ContentModels implementation returns them.
var (
	// ErrItemGone answers an item that no longer exists or is no longer
	// library content of the kind.
	ErrItemGone = errors.New("content item not found")
	// ErrItemTooLarge answers an item whose model exceeds its bounds.
	ErrItemTooLarge = errors.New("content item model is too large")
)

// CheckFailure is a check that did not complete. Code is stable.
type CheckFailure struct{ Code string }

func (f *CheckFailure) Error() string { return "plugin content check failed: " + f.Code }

// Failure codes of a check.
const (
	CheckFailed        = "check_failed"
	CheckTimeout       = "check_timeout"
	CheckPanic         = "check_panic"
	CheckInvalidResult = "invalid_result"
	CheckItemTooLarge  = "item_too_large"
)

// MaxCheckedItemsPerSweep bounds the items one check reads in one sweep, for
// each kind. Items never checked go first, then the ones checked longest
// ago, so every item is reached on a later sweep.
const MaxCheckedItemsPerSweep = 200

// SetPluginChecks wires the provider slot. Without it, no plugin check runs.
func (s *Service) SetPluginChecks(checks PluginChecks, models ContentModels, logger *slog.Logger) {
	s.checks, s.models = checks, models
	if logger == nil {
		logger = slog.Default()
	}
	s.logger = logger
}

// relatedTypes are the incident related_type of each item kind.
var relatedTypes = map[string]string{
	plugin.ContentKindPlaylist:       "playlist",
	plugin.ContentKindLayout:         "layout",
	plugin.ContentKindWidgetInstance: "asset",
	plugin.ContentKindMediaItem:      "asset",
}

func checkPrefix(pluginID, checkID string) string {
	return "plugin_check:" + pluginID + ":" + checkID + ":"
}

func itemPrefix(check PluginCheck, kind string, id uuid.UUID) string {
	return checkPrefix(check.PluginID, check.CheckID) + kind + ":" + id.String() + ":"
}

// sweepPluginChecks runs every installed check on its changed items, then
// recovers the conditions of checks that no installed plugin declares.
func (s *Service) sweepPluginChecks(ctx context.Context) error {
	if s.checks == nil || s.models == nil {
		return nil
	}
	checks, err := s.checks.ContentChecks(ctx)
	if err != nil {
		return err
	}
	if err := s.retireChecks(ctx, checks); err != nil {
		return err
	}
	for _, check := range checks {
		for _, kind := range check.Kinds {
			if err := s.sweepCheckKind(ctx, check, kind); err != nil {
				return err
			}
		}
	}
	return nil
}

type checkState struct {
	fingerprint string
	checkedAt   time.Time
	succeeded   *time.Time
	// failure is set by a failed run and cleared by a completed one.
	failure string
}

// current reports whether the last run completed on this fingerprint.
func (c checkState) current(fingerprint string) bool {
	return c.fingerprint == fingerprint && c.succeeded != nil && c.failure == ""
}

func (s *Service) sweepCheckKind(ctx context.Context, check PluginCheck, kind string) error {
	ids, err := s.models.IDs(ctx, kind)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT item_id,COALESCE(fingerprint,''),checked_at,succeeded_at,COALESCE(failure,'') FROM plugin_content_check_state
		WHERE plugin_id=$1 AND check_id=$2 AND item_kind=$3`, check.PluginID, check.CheckID, kind)
	if err != nil {
		return err
	}
	states := map[uuid.UUID]checkState{}
	_, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (struct{}, error) {
		var id uuid.UUID
		var state checkState
		err := row.Scan(&id, &state.fingerprint, &state.checkedAt, &state.succeeded, &state.failure)
		states[id] = state
		return struct{}{}, err
	})
	if err != nil {
		return err
	}
	present := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		present[id] = true
	}
	for id := range states {
		if !present[id] {
			if err := s.forgetItem(ctx, check, kind, id); err != nil {
				return err
			}
		}
	}
	// Never-checked items first, then the oldest checks.
	sort.SliceStable(ids, func(i, j int) bool {
		a, aok := states[ids[i]]
		b, bok := states[ids[j]]
		if aok != bok {
			return !aok
		}
		return a.checkedAt.Before(b.checkedAt)
	})
	if len(ids) > MaxCheckedItemsPerSweep {
		ids = ids[:MaxCheckedItemsPerSweep]
	}
	for _, id := range ids {
		if err := s.checkItem(ctx, check, kind, id, states[id]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) checkItem(ctx context.Context, check PluginCheck, kind string, id uuid.UUID, state checkState) error {
	now := s.clock()
	model, err := s.models.Model(ctx, kind, id)
	switch {
	case errors.Is(err, ErrItemGone):
		return s.forgetItem(ctx, check, kind, id)
	case errors.Is(err, ErrItemTooLarge):
		return s.recordCheckFailure(ctx, check, kind, id, now, CheckItemTooLarge)
	case err != nil:
		s.logger.Warn("content model could not be built", "kind", kind, "item", id, "error", err)
		return nil
	}
	fingerprint, err := Fingerprint(model)
	if err != nil {
		return err
	}
	if state.current(fingerprint) {
		_, err := s.db.Exec(ctx, `UPDATE plugin_content_check_state SET checked_at=$5
			WHERE plugin_id=$1 AND check_id=$2 AND item_kind=$3 AND item_id=$4`, check.PluginID, check.CheckID, kind, id, now)
		return err
	}
	model.Check = check.CheckID
	conditions, err := s.checks.RunContentCheck(ctx, check.PluginID, check.CheckID, model)
	if err != nil {
		code := CheckFailed
		var failure *CheckFailure
		if errors.As(err, &failure) {
			code = failure.Code
		}
		return s.recordCheckFailure(ctx, check, kind, id, now, code)
	}
	return s.applyConditions(ctx, check, kind, id, model.Name, fingerprint, now, conditions)
}

// Fingerprint is the SHA-256 of the canonical JSON of a model: encoded,
// decoded, and encoded again, so every object's keys are sorted, also those
// of an embedded document. The check ID is not part of it.
func Fingerprint(item plugin.ContentItem) (string, error) {
	item.Check = ""
	encoded, err := json.Marshal(item)
	if err != nil {
		return "", err
	}
	var generic any
	if err := json.Unmarshal(encoded, &generic); err != nil {
		return "", err
	}
	canonical, err := json.Marshal(generic)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

// recordCheckFailure keeps the earlier fingerprint and conditions.
func (s *Service) recordCheckFailure(ctx context.Context, check PluginCheck, kind string, id uuid.UUID, now time.Time, code string) error {
	_, err := s.db.Exec(ctx, `INSERT INTO plugin_content_check_state(plugin_id,check_id,item_kind,item_id,checked_at,failed_at,failure)
		VALUES($1,$2,$3,$4,$5,$5,$6)
		ON CONFLICT (plugin_id,check_id,item_kind,item_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,failed_at=EXCLUDED.failed_at,failure=EXCLUDED.failure`,
		check.PluginID, check.CheckID, kind, id, now, code)
	return err
}

func truncateText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

// applyConditions records a completed check in one transaction: the new
// fingerprint, an incident for each condition (opened, or kept when it is
// already open), and the recovery of the item's earlier conditions that the
// check no longer returns.
func (s *Service) applyConditions(ctx context.Context, check PluginCheck, kind string, id uuid.UUID, name, fingerprint string, now time.Time, conditions []plugin.Condition) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `INSERT INTO plugin_content_check_state(plugin_id,check_id,item_kind,item_id,fingerprint,checked_at,succeeded_at)
		VALUES($1,$2,$3,$4,$5,$6,$6)
		ON CONFLICT (plugin_id,check_id,item_kind,item_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,
			checked_at=EXCLUDED.checked_at,succeeded_at=EXCLUDED.succeeded_at,failed_at=NULL,failure=NULL`,
		check.PluginID, check.CheckID, kind, id, fingerprint, now); err != nil {
		return err
	}
	prefix := itemPrefix(check, kind, id)
	keep := make([]string, 0, len(conditions))
	var opened []uuid.UUID
	title := truncateText(check.Title+": "+name, 200)
	for _, condition := range conditions {
		key := prefix + condition.Name
		keep = append(keep, key)
		metadata, _ := json.Marshal(map[string]string{"source": "plugin_check", "pluginId": check.PluginID, "check": check.CheckID,
			"itemKind": kind, "itemId": id.String(), "itemName": truncateText(name, 200), "condition": condition.Name})
		var incident uuid.UUID
		var inserted bool
		err := tx.QueryRow(ctx, `INSERT INTO incidents(
				id,incident_type,severity,status,title,description,opened_at,last_seen_at,
				failure_code,probable_cause,related_type,related_id,dedupe_key,metadata)
			VALUES(gen_random_uuid(),'content',$1,'open',$2,$3,$4,$4,'plugin_check',$3,$5,$6,$7,$8)
			ON CONFLICT (dedupe_key) WHERE status IN ('open','acknowledged') DO UPDATE
			SET last_seen_at=EXCLUDED.last_seen_at, severity=EXCLUDED.severity, description=EXCLUDED.description,
				probable_cause=EXCLUDED.probable_cause, title=EXCLUDED.title, updated_at=now()
			RETURNING id, (xmax = 0)`,
			condition.Severity, title, condition.Reason, now, relatedTypes[kind], id.String(), key, metadata).Scan(&incident, &inserted)
		if err != nil {
			return err
		}
		if inserted {
			opened = append(opened, incident)
		}
	}
	if err := coreevents.EmitIncidents(ctx, tx, s.events, plugin.CoreIncidentOpened, coreevents.IncidentDetected, now, opened...); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `UPDATE incidents SET status='recovered',recovered_at=$3,recovery_mode='automatic',
			resolution_reason='The check no longer reports this condition.',updated_at=now()
		WHERE failure_code='plugin_check' AND status IN ('open','acknowledged')
		  AND left(dedupe_key, length($1))=$1 AND NOT (dedupe_key = ANY($2))
		RETURNING id`, prefix, keep, now)
	if err := s.emitIDs(ctx, tx, rows, err, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// forgetItem recovers the conditions of an item that no longer exists and
// deletes its check state.
func (s *Service) forgetItem(ctx context.Context, check PluginCheck, kind string, id uuid.UUID) error {
	return s.recoverWhere(ctx, itemPrefix(check, kind, id), "The content item was removed.", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM plugin_content_check_state WHERE plugin_id=$1 AND check_id=$2 AND item_kind=$3 AND item_id=$4`,
			check.PluginID, check.CheckID, kind, id)
		return err
	})
}

func (s *Service) recoverWhere(ctx context.Context, prefix, reason string, also func(pgx.Tx) error) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	rows, err := tx.Query(ctx, `UPDATE incidents SET status='recovered',recovered_at=$2,recovery_mode='automatic',
			resolution_reason=$3,updated_at=now()
		WHERE failure_code='plugin_check' AND status IN ('open','acknowledged') AND left(dedupe_key, length($1))=$1
		RETURNING id`, prefix, s.clock(), reason)
	if err := s.emitIDs(ctx, tx, rows, err, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic); err != nil {
		return err
	}
	if err := also(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// retireChecks recovers the conditions and deletes the state of every
// check that no installed plugin declares now: a removed plugin, or a
// check or kind a definition upgrade removed.
func (s *Service) retireChecks(ctx context.Context, checks []PluginCheck) error {
	current := []string{}
	for _, check := range checks {
		for _, kind := range check.Kinds {
			current = append(current, check.PluginID+"/"+check.CheckID+"/"+kind)
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	rows, err := tx.Query(ctx, `UPDATE incidents SET status='recovered',recovered_at=$2,recovery_mode='automatic',
			resolution_reason='The check that reported this condition is no longer installed.',updated_at=now()
		WHERE failure_code='plugin_check' AND status IN ('open','acknowledged')
		  AND NOT ((metadata->>'pluginId')||'/'||(metadata->>'check')||'/'||(metadata->>'itemKind') = ANY($1))
		RETURNING id`, current, s.clock())
	if err := s.emitIDs(ctx, tx, rows, err, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM plugin_content_check_state WHERE NOT (plugin_id||'/'||check_id||'/'||item_kind = ANY($1))`, current); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
