package plugins

import (
	"context"
	"errors"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/durable"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/kvstore"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Durable timers of bundled Plugin Manifest API 3 plugins
// (docs/plugin-storage.md#durable-timers). A timer is a row of
// plugin_timers. Delivery is at least once: a worker claims a due row with a
// lease through internal/durable, runs the plugin's HandleTimer in the
// system context outside the claiming transaction, and completes or retries
// only the generation it claimed.

// Timer delivery timings.
const (
	// timerLease bounds one claim. It is longer than timerCallTimeout, so a
	// running callback keeps its claim; after a crash the row is claimable
	// again when the lease ends.
	timerLease       = 2 * time.Minute
	timerCallTimeout = 30 * time.Second
	timerBatch       = 20
	timerTick        = 5 * time.Second
	// Retries back off from timerRetryBase, doubling, to at most
	// timerRetryMax. After timerMaxAttempts deliveries the host drops the
	// timer and logs it.
	timerRetryBase   = 5 * time.Second
	timerRetryMax    = time.Hour
	timerMaxAttempts = 10
)

var timerQueue = durable.Queue{Table: "plugin_timers"}

// Timer failures for the service registry.
var (
	ErrTimerInvalid = errors.New("invalid timer")
	ErrTimerLimit   = errors.New("the plugin has the most pending timers it can hold")
)

func declaresService(manifest plugin.Manifest, reference string) bool {
	return slices.Contains(manifest.Services, reference)
}

func (s *Service) timerPlugin(pluginID string) (hostedPlugin, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 || !declaresService(hosted.manifest, "timers.schedule@1") {
		return hostedPlugin{}, ErrPluginNotFound
	}
	return hosted, nil
}

func validTimerKey(key string) bool {
	if kvstore.CheckKey(key) != nil || !utf8.ValidString(key) {
		return false
	}
	for _, r := range key {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// ScheduleTimer schedules one callback. Scheduling a key again deletes the
// pending row of the key, a running one included, and inserts a new
// generation with a new ID. It returns the new ID and the due time.
func (s *Service) ScheduleTimer(ctx context.Context, pluginID, key string, at time.Time, payload []byte) (uuid.UUID, time.Time, error) {
	hosted, err := s.timerPlugin(pluginID)
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	now := s.clock.Now()
	switch {
	case !validTimerKey(key):
		return uuid.Nil, time.Time{}, ErrTimerInvalid
	case len(payload) > plugin.MaxTimerPayloadBytes:
		return uuid.Nil, time.Time{}, ErrTimerInvalid
	case at.IsZero() || at.After(now.Add(plugin.MaxTimerDelay)):
		return uuid.Nil, time.Time{}, ErrTimerInvalid
	}
	if payload == nil {
		payload = []byte{}
	}
	id := uuid.New()
	due := at.UTC().Truncate(time.Microsecond)
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := kvstore.Lock(ctx, tx, "plugin_timers:"+pluginID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_timers WHERE plugin_id=$1 AND timer_key=$2`, pluginID, key); err != nil {
			return err
		}
		var pending int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM plugin_timers WHERE plugin_id=$1`, pluginID).Scan(&pending); err != nil {
			return err
		}
		if pending >= plugin.MaxTimersPerPlugin {
			return ErrTimerLimit
		}
		_, err := tx.Exec(ctx, `INSERT INTO plugin_timers(id,plugin_id,timer_key,payload,definition_version,due_at) VALUES($1,$2,$3,$4,$5,$6)`,
			id, pluginID, key, payload, hosted.manifest.DefinitionVersion, due)
		return err
	})
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	return id, due, nil
}

// CancelTimer removes the pending timer of a key, a running one included:
// a callback that is running finishes, and its completion then changes
// nothing.
func (s *Service) CancelTimer(ctx context.Context, pluginID, key string) (bool, error) {
	if _, err := s.timerPlugin(pluginID); err != nil {
		return false, err
	}
	if !validTimerKey(key) {
		return false, ErrTimerInvalid
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM plugin_timers WHERE plugin_id=$1 AND timer_key=$2`, pluginID, key)
	return tag.RowsAffected() > 0, err
}

// RunDueTimers delivers the due timers of every installed plugin that
// handles timers, and reports how many callbacks ran. A removed plugin's
// timers stay inert until it is installed again. A timer scheduled under
// another definitionVersion never fires: the host deletes it and logs it.
func (s *Service) RunDueTimers(ctx context.Context) (int, error) {
	installed, err := s.installedPluginIDs(ctx)
	if err != nil {
		return 0, err
	}
	ran := 0
	for _, hosted := range s.hosted {
		handler, ok := hosted.plugin.(plugin.TimerHandler)
		if !ok || hosted.manifest.APIVersion < 3 || !installed[hosted.manifest.ID] || !declaresService(hosted.manifest, "timers.schedule@1") {
			continue
		}
		count, err := s.runPluginTimers(ctx, hosted, handler)
		ran += count
		if err != nil {
			return ran, err
		}
	}
	return ran, nil
}

func (s *Service) installedPluginIDs(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.Query(ctx, `SELECT plugin_id FROM plugin_installations`)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

func (s *Service) runPluginTimers(ctx context.Context, hosted hostedPlugin, handler plugin.TimerHandler) (int, error) {
	pluginID, version := hosted.manifest.ID, hosted.manifest.DefinitionVersion
	now := s.clock.Now()
	tag, err := s.db.Exec(ctx, `DELETE FROM plugin_timers WHERE plugin_id=$1 AND definition_version<>$2
		AND (claimed_until IS NULL OR claimed_until<=$3)`, pluginID, version, now)
	if err != nil {
		return 0, err
	}
	if dropped := tag.RowsAffected(); dropped > 0 {
		s.logger.Info("plugin timers of another definition dropped", "plugin", pluginID, "count", dropped, "definitionVersion", version)
	}
	claims, err := timerQueue.Claim(ctx, s.db, now, timerLease, timerBatch,
		durable.Filter{Where: "plugin_id=$4 AND definition_version=$5", Args: []any{pluginID, version}})
	if err != nil {
		return 0, err
	}
	for _, claim := range claims {
		if err := s.deliverTimer(ctx, pluginID, handler, claim); err != nil && ctx.Err() != nil {
			return 0, err
		}
	}
	return len(claims), nil
}

func (s *Service) deliverTimer(ctx context.Context, pluginID string, handler plugin.TimerHandler, claim durable.Claim) error {
	timer := plugin.Timer{ID: claim.ID.String(), Attempt: claim.Attempt}
	err := s.db.QueryRow(ctx, `SELECT timer_key,payload,due_at FROM plugin_timers WHERE id=$1 AND claim_token=$2`, claim.ID, claim.Token).
		Scan(&timer.Key, &timer.Payload, &timer.DueAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Replaced or cancelled after the claim.
		return nil
	}
	if err != nil {
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, timerCallTimeout)
	callCtx, done := s.systemInvocation(callCtx, pluginID)
	failure := runTimerHandler(callCtx, handler, timer)
	done()
	cancel()
	if failure == "" {
		_, err := timerQueue.Complete(ctx, s.db, claim)
		return err
	}
	if claim.Attempt >= timerMaxAttempts {
		if _, err := timerQueue.Complete(ctx, s.db, claim); err != nil {
			return err
		}
		s.logger.Warn("plugin timer dropped after its last attempt", "plugin", pluginID, "timer", claim.ID, "attempts", claim.Attempt, "failure", failure)
		return nil
	}
	s.logger.Info("plugin timer failed; it runs again", "plugin", pluginID, "timer", claim.ID, "attempt", claim.Attempt, "failure", failure)
	_, err = timerQueue.Retry(ctx, s.db, claim, s.clock.Now().Add(durable.Backoff(claim.Attempt, timerRetryBase, timerRetryMax)), failure)
	return err
}

// runTimerHandler runs a callback and returns a stable failure code, or ""
// on success. A panic is a failure of the callback, not of the host.
func runTimerHandler(ctx context.Context, handler plugin.TimerHandler, timer plugin.Timer) (failure string) {
	defer func() {
		if recover() != nil {
			failure = "handler_panic"
		}
	}()
	if err := handler.HandleTimer(ctx, timer); err != nil {
		if ctx.Err() != nil {
			return "handler_timeout"
		}
		return "handler_error"
	}
	return ""
}
