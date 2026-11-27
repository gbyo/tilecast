package plugindelivery

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/durable"
)

// Clock is the time source of the engine. Tests step it.
type Clock interface{ Now() time.Time }

// Delivery is one claimed item as a Target receives it.
type Delivery struct {
	// ID is stable across every attempt of the item.
	ID       uuid.UUID
	PluginID string
	Kind     string
	Source   string
	// Subject is the producer's subject, without the kind prefix.
	Subject   string
	Payload   []byte
	Metadata  json.RawMessage
	DueAt     time.Time
	CreatedAt time.Time
	// Attempt is 1 for the first delivery.
	Attempt int
}

// Target is one installed plugin the engine delivers to.
type Target interface {
	// DefinitionVersion is the plugin's current manifest definitionVersion.
	// An item of another version never runs; the engine deletes it.
	DefinitionVersion() int
	// Accepts reports whether the plugin still takes items of a kind and
	// source: it still handles timers, still subscribes to an event, or
	// still declares a webhook. The engine deletes items it does not.
	Accepts(kind, source string) bool
	// Deliver runs the plugin's callback. An error, a panic, or the end of
	// the call time limit is a failed attempt.
	Deliver(ctx context.Context, delivery Delivery) error
}

// Directory returns the Target of a plugin that this Server hosts.
type Directory interface {
	Target(pluginID string) (Target, bool)
}

// Engine claims due items and runs them. Several engines, in one or more
// Server processes, can share a database: the claim transaction holds an
// advisory lock for the plugin, so the subject rule and the concurrency
// bound hold across processes.
type Engine struct {
	db          *pgxpool.Pool
	directory   Directory
	clock       Clock
	logger      *slog.Logger
	callTimeout time.Duration
}

// Option configures an Engine.
type Option func(*Engine)

// WithCallTimeout replaces CallTimeout. Tests use it so that a timeout
// test does not wait 30 seconds.
func WithCallTimeout(timeout time.Duration) Option {
	return func(e *Engine) { e.callTimeout = timeout }
}

// NewEngine makes an engine.
func NewEngine(db *pgxpool.Pool, directory Directory, clock Clock, logger *slog.Logger, options ...Option) *Engine {
	if logger == nil {
		logger = slog.Default()
	}
	e := &Engine{db: db, directory: directory, clock: clock, logger: logger, callTimeout: CallTimeout}
	for _, option := range options {
		option(e)
	}
	return e
}

type claimed struct {
	Delivery
	token uuid.UUID
}

// RunDue claims every item that can run now, runs the claimed items in
// parallel, and waits for them. It reports how many items ran. Tests and
// the maintenance loop of a single pass use it.
func (e *Engine) RunDue(ctx context.Context) (int, error) {
	return e.dispatch(ctx, true)
}

// Start claims every item that can run now and starts the callbacks
// without waiting for them. The live claims of earlier passes still count
// against the concurrency bound of each plugin.
func (e *Engine) Start(ctx context.Context) (int, error) {
	return e.dispatch(ctx, false)
}

func (e *Engine) dispatch(ctx context.Context, wait bool) (int, error) {
	now := e.clock.Now()
	plugins, err := e.duePlugins(ctx, now)
	if err != nil {
		return 0, err
	}
	var wg sync.WaitGroup
	started := 0
	for _, pluginID := range plugins {
		target, ok := e.directory.Target(pluginID)
		if !ok {
			continue
		}
		claims, claimErr := e.claim(ctx, pluginID, target, now)
		if claimErr != nil {
			err = claimErr
			break
		}
		for _, item := range claims {
			wg.Add(1)
			started++
			go func(item claimed) {
				defer wg.Done()
				e.execute(ctx, target, item)
			}(item)
		}
	}
	if wait {
		wg.Wait()
	}
	return started, err
}

// duePlugins lists installed plugins with an item that may run now.
func (e *Engine) duePlugins(ctx context.Context, now time.Time) ([]string, error) {
	rows, err := e.db.Query(ctx, `SELECT DISTINCT d.plugin_id FROM plugin_deliveries d
		JOIN plugin_installations i ON i.plugin_id=d.plugin_id AND i.installed_at=d.installed_at
		WHERE d.state='pending' AND d.next_attempt_at<=$1 AND (d.claimed_until IS NULL OR d.claimed_until<=$1)
		ORDER BY d.plugin_id`, now)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// claim claims the free subjects of one plugin within its bound.
func (e *Engine) claim(ctx context.Context, pluginID string, target Target, now time.Time) ([]claimed, error) {
	var out []claimed
	err := pgx.BeginFunc(ctx, e.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "plugin_deliveries:"+pluginID); err != nil {
			return err
		}
		installedAt, installed, err := installation(ctx, tx, pluginID)
		if err != nil || !installed {
			return err
		}
		// An item of an earlier installation, a cancelled item whose claim
		// ended, or an item of another definition that no claim holds,
		// never runs.
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_deliveries WHERE plugin_id=$1 AND (installed_at<>$4
			OR (claimed_until IS NULL OR claimed_until<=$2) AND (state='cancelled' OR definition_version<>$3))`,
			pluginID, now, target.DefinitionVersion(), installedAt); err != nil {
			return err
		}
		// An item whose last allowed attempt ended without a result parks.
		parked, err := tx.Exec(ctx, `UPDATE plugin_deliveries SET state='parked', parked_at=$2, claim_token=NULL, claimed_until=NULL, last_error=$4
			WHERE plugin_id=$1 AND state='pending' AND claimed_until<=$2 AND attempts>=$3`, pluginID, now, MaxAttempts, FailureLeaseExpired)
		if err != nil {
			return err
		}
		if parked.RowsAffected() > 0 {
			if err := recordFailure(ctx, tx, pluginID, "", FailureLeaseExpired, now); err != nil {
				return err
			}
		}
		var live int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM plugin_deliveries WHERE plugin_id=$1 AND claimed_until>$2`, pluginID, now).Scan(&live); err != nil {
			return err
		}
		slots := ConcurrencyPerPlugin - live
		if slots <= 0 {
			return nil
		}
		token := uuid.New()
		rows, err := tx.Query(ctx, `WITH heads AS (
				SELECT DISTINCT ON (subject) id, state, sequence, next_attempt_at, claimed_until
				FROM plugin_deliveries WHERE plugin_id=$1 AND state IN ('pending','cancelled')
				ORDER BY subject, sequence
			), free AS (
				SELECT id FROM heads WHERE state='pending' AND next_attempt_at<=$2 AND (claimed_until IS NULL OR claimed_until<=$2)
				ORDER BY next_attempt_at, sequence LIMIT $3
			)
			UPDATE plugin_deliveries d SET claim_token=$4, claimed_until=$5, attempts=d.attempts+1
			FROM free WHERE d.id=free.id
			RETURNING d.id, d.kind, d.source, d.subject, d.payload, d.metadata, d.due_at, d.created_at, d.attempts`,
			pluginID, now, slots, token, now.Add(Lease))
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (claimed, error) {
			item := claimed{token: token}
			item.PluginID = pluginID
			err := row.Scan(&item.ID, &item.Kind, &item.Source, &item.Subject, &item.Payload, &item.Metadata, &item.DueAt, &item.CreatedAt, &item.Attempt)
			item.Subject = strings.TrimPrefix(item.Subject, item.Kind+":")
			return item, err
		})
		return err
	})
	return out, err
}

func (e *Engine) execute(ctx context.Context, target Target, item claimed) {
	if !target.Accepts(item.Kind, item.Source) {
		e.settle(ctx, item, "", true)
		e.logger.Info("plugin delivery no longer accepted; deleted", "plugin", item.PluginID, "kind", item.Kind, "delivery", item.ID)
		return
	}
	callCtx, cancel := context.WithTimeout(ctx, e.callTimeout)
	failure := deliver(callCtx, target, item.Delivery)
	cancel()
	if ctx.Err() != nil {
		e.release(item)
		return
	}
	e.settle(ctx, item, failure, false)
}

// deliver runs one callback and returns a stable failure code, or "" on
// success. A panic is a failure of the callback, never of the Server.
func deliver(ctx context.Context, target Target, delivery Delivery) (failure string) {
	defer func() {
		if recover() != nil {
			failure = FailureHandlerPanic
		}
	}()
	if err := target.Deliver(ctx, delivery); err != nil {
		if ctx.Err() != nil {
			return FailureHandlerTimeout
		}
		return FailureHandlerError
	}
	return ""
}

// settle completes, retries, or parks a claimed item. Each change names the
// item and the claim token: a worker whose lease was taken over, or whose
// item was cancelled or replaced, changes nothing but its own cancelled
// row.
func (e *Engine) settle(ctx context.Context, item claimed, failure string, drop bool) {
	now := e.clock.Now()
	err := pgx.BeginFunc(ctx, e.db, func(tx pgx.Tx) error {
		if failure == "" || drop {
			_, err := tx.Exec(ctx, `DELETE FROM plugin_deliveries WHERE id=$1 AND claim_token=$2`, item.ID, item.token)
			return err
		}
		var tag interface{ RowsAffected() int64 }
		var err error
		if item.Attempt >= MaxAttempts {
			tag, err = tx.Exec(ctx, `UPDATE plugin_deliveries SET state='parked', parked_at=$3, claim_token=NULL, claimed_until=NULL, last_error=$4
				WHERE id=$1 AND claim_token=$2 AND state='pending'`, item.ID, item.token, now, failure)
		} else {
			tag, err = tx.Exec(ctx, `UPDATE plugin_deliveries SET next_attempt_at=$3, claim_token=NULL, claimed_until=NULL, last_error=$4
				WHERE id=$1 AND claim_token=$2 AND state='pending'`, item.ID, item.token, now.Add(retryDelay(item.Attempt)), failure)
		}
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// Cancelled or replaced while it ran: the claim ends here.
			_, err = tx.Exec(ctx, `DELETE FROM plugin_deliveries WHERE id=$1 AND claim_token=$2 AND state='cancelled'`, item.ID, item.token)
			return err
		}
		return recordFailure(ctx, tx, item.PluginID, item.Kind, failure, now)
	})
	if err != nil {
		e.logger.Warn("plugin delivery result was not recorded; the lease will expire", "plugin", item.PluginID, "kind", item.Kind, "delivery", item.ID)
		return
	}
	switch {
	case failure == "":
	case item.Attempt >= MaxAttempts:
		e.logger.Warn("plugin delivery parked after its last attempt", "plugin", item.PluginID, "kind", item.Kind, "delivery", item.ID, "attempts", item.Attempt, "failure", failure)
	default:
		e.logger.Info("plugin delivery failed; it runs again", "plugin", item.PluginID, "kind", item.Kind, "delivery", item.ID, "attempt", item.Attempt, "failure", failure)
	}
}

// release gives back the claim of an item whose callback a shutdown
// interrupted. The attempt does not count.
func (e *Engine) release(item claimed) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := e.db.Exec(ctx, `WITH gone AS (DELETE FROM plugin_deliveries WHERE id=$1 AND claim_token=$2 AND state='cancelled')
		UPDATE plugin_deliveries SET claim_token=NULL, claimed_until=NULL, attempts=greatest(attempts-1,0)
		WHERE id=$1 AND claim_token=$2 AND state='pending'`, item.ID, item.token)
	if err != nil {
		e.logger.Warn("plugin delivery claim was not released; the lease will expire", "plugin", item.PluginID, "delivery", item.ID)
	}
}

// retryDelay is the wait after a failed attempt: RetryBase after the first,
// doubling, never above RetryMax.
func retryDelay(attempt int) time.Duration {
	return durable.Backoff(attempt, RetryBase, RetryMax)
}

func recordFailure(ctx context.Context, tx pgx.Tx, pluginID, kind, code string, at time.Time) error {
	var kindValue *string
	if kind != "" {
		kindValue = &kind
	}
	_, err := tx.Exec(ctx, `INSERT INTO plugin_delivery_status(plugin_id,last_failure_code,last_failure_kind,last_failure_at) VALUES($1,$2,$3,$4)
		ON CONFLICT (plugin_id) DO UPDATE SET last_failure_code=EXCLUDED.last_failure_code, last_failure_kind=EXCLUDED.last_failure_kind, last_failure_at=EXCLUDED.last_failure_at`,
		pluginID, code, kindValue, at)
	return err
}

// Run delivers until ctx ends: every tick it starts the items that can run.
// allowed, when not nil, pauses delivery, for example while a restore
// holds background work.
func (e *Engine) Run(ctx context.Context, tick, sweep time.Duration, allowed func() bool) {
	ticker := time.NewTicker(tick)
	sweeper := time.NewTicker(sweep)
	defer ticker.Stop()
	defer sweeper.Stop()
	e.pass(ctx, allowed, true)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.pass(ctx, allowed, false)
		case <-sweeper.C:
			e.pass(ctx, allowed, true)
		}
	}
}

func (e *Engine) pass(ctx context.Context, allowed func() bool, sweep bool) {
	if allowed != nil && !allowed() {
		return
	}
	if sweep {
		if _, err := e.Sweep(ctx); err != nil && ctx.Err() == nil {
			e.logger.Warn("plugin delivery sweep failed", "error", err)
		}
	}
	if _, err := e.Start(ctx); err != nil && ctx.Err() == nil {
		e.logger.Warn("plugin delivery pass failed", "error", err)
	}
}
