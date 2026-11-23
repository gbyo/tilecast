package plugindelivery

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Swept counts what one sweep removed.
type Swept struct {
	// Expired counts pending items past PendingRetention and parked items
	// past ParkedRetention. The status of each plugin keeps the count.
	Expired int
	// Reconciled counts items that their plugin no longer accepts, items of
	// plugins that are not installed, and finished cancelled items.
	Reconciled int
}

// Sweep expires old items and removes items that can never run. The
// Server runs it at startup and then periodically.
func (e *Engine) Sweep(ctx context.Context) (Swept, error) {
	now := e.clock.Now()
	var swept Swept
	err := pgx.BeginFunc(ctx, e.db, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `WITH expired AS (
				DELETE FROM plugin_deliveries
				WHERE (state='pending' AND due_at<$1 AND (claimed_until IS NULL OR claimed_until<=$3))
					OR (state='parked' AND parked_at<$2)
				RETURNING plugin_id
			)
			SELECT plugin_id, count(*) FROM expired GROUP BY plugin_id`,
			now.Add(-PendingRetention), now.Add(-ParkedRetention), now)
		if err != nil {
			return err
		}
		type count struct {
			pluginID string
			n        int64
		}
		counts, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (count, error) {
			var c count
			return c, row.Scan(&c.pluginID, &c.n)
		})
		if err != nil {
			return err
		}
		for _, c := range counts {
			swept.Expired += int(c.n)
			if _, err := tx.Exec(ctx, `INSERT INTO plugin_delivery_status(plugin_id,expired_count,last_expired_at) VALUES($1,$2,$3)
				ON CONFLICT (plugin_id) DO UPDATE SET expired_count=plugin_delivery_status.expired_count+EXCLUDED.expired_count, last_expired_at=EXCLUDED.last_expired_at`,
				c.pluginID, c.n, now); err != nil {
				return err
			}
		}
		gone, err := tx.Exec(ctx, `DELETE FROM plugin_deliveries d
			WHERE (d.state='cancelled' AND (d.claimed_until IS NULL OR d.claimed_until<=$1))
				OR NOT EXISTS (SELECT 1 FROM plugin_installations i WHERE i.plugin_id=d.plugin_id)`, now)
		if err != nil {
			return err
		}
		swept.Reconciled += int(gone.RowsAffected())
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_delivery_status s
			WHERE NOT EXISTS (SELECT 1 FROM plugin_installations i WHERE i.plugin_id=s.plugin_id)`); err != nil {
			return err
		}
		sources, err := tx.Query(ctx, `SELECT DISTINCT plugin_id, kind, source FROM plugin_deliveries WHERE state<>'cancelled'`)
		if err != nil {
			return err
		}
		type source struct{ pluginID, kind, source string }
		list, err := pgx.CollectRows(sources, func(row pgx.CollectableRow) (source, error) {
			var s source
			return s, row.Scan(&s.pluginID, &s.kind, &s.source)
		})
		if err != nil {
			return err
		}
		for _, s := range list {
			target, ok := e.directory.Target(s.pluginID)
			if !ok || target.Accepts(s.kind, s.source) {
				continue
			}
			n, err := CancelSource(ctx, tx, now, s.pluginID, s.kind, s.source)
			if err != nil {
				return err
			}
			swept.Reconciled += int(n)
		}
		return nil
	})
	if swept.Expired > 0 {
		e.logger.Info("plugin deliveries expired", "count", swept.Expired)
	}
	return swept, err
}

// Status is the delivery state of one plugin. It never holds a payload, a
// metadata value, or an error text.
type Status struct {
	Pending       int            `json:"pending"`
	Running       int            `json:"running"`
	ParkedCount   int            `json:"parkedCount"`
	Parked        []Parked       `json:"parked"`
	ExpiredCount  int64          `json:"expiredCount"`
	LastExpiredAt *time.Time     `json:"lastExpiredAt"`
	LastFailure   *FailureStatus `json:"lastFailure"`
}

// FailureStatus is the last failed attempt of a plugin.
type FailureStatus struct {
	Code string `json:"code"`
	// Kind is empty when the failure belongs to no single kind, such as an
	// expired claim.
	Kind string    `json:"kind,omitempty"`
	At   time.Time `json:"at"`
}

// Parked is one parked item.
type Parked struct {
	ID        uuid.UUID `json:"id"`
	Kind      string    `json:"kind"`
	Source    string    `json:"source"`
	Subject   string    `json:"subject"`
	Attempts  int       `json:"attempts"`
	LastError string    `json:"lastError"`
	DueAt     time.Time `json:"dueAt"`
	ParkedAt  time.Time `json:"parkedAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// MaxParkedListed bounds the parked items one status lists, newest first.
const MaxParkedListed = 50

type queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// ReadStatus reads the delivery state of one plugin.
func ReadStatus(ctx context.Context, db queryer, pluginID string, now time.Time) (Status, error) {
	status := Status{Parked: []Parked{}}
	if err := db.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE state='pending'),
			count(*) FILTER (WHERE state='pending' AND claimed_until>$2),
			count(*) FILTER (WHERE state='parked')
		FROM plugin_deliveries WHERE plugin_id=$1`, pluginID, now).Scan(&status.Pending, &status.Running, &status.ParkedCount); err != nil {
		return Status{}, err
	}
	var code, kind *string
	var failedAt *time.Time
	err := db.QueryRow(ctx, `SELECT expired_count,last_expired_at,last_failure_code,last_failure_kind,last_failure_at
		FROM plugin_delivery_status WHERE plugin_id=$1`, pluginID).Scan(&status.ExpiredCount, &status.LastExpiredAt, &code, &kind, &failedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Status{}, err
	}
	if code != nil && failedAt != nil {
		status.LastFailure = &FailureStatus{Code: *code, At: *failedAt}
		if kind != nil {
			status.LastFailure.Kind = *kind
		}
	}
	rows, err := db.Query(ctx, `SELECT `+parkedColumns+` FROM plugin_deliveries WHERE plugin_id=$1 AND state='parked'
		ORDER BY parked_at DESC, id LIMIT $2`, pluginID, MaxParkedListed)
	if err != nil {
		return Status{}, err
	}
	status.Parked, err = pgx.CollectRows(rows, scanParked)
	return status, err
}

const parkedColumns = `id,kind,source,subject,attempts,coalesce(last_error,''),due_at,parked_at`

func scanParked(row pgx.CollectableRow) (Parked, error) {
	var item Parked
	err := row.Scan(&item.ID, &item.Kind, &item.Source, &item.Subject, &item.Attempts, &item.LastError, &item.DueAt, &item.ParkedAt)
	item.Subject = strings.TrimPrefix(item.Subject, item.Kind+":")
	item.ExpiresAt = item.ParkedAt.Add(ParkedRetention)
	return item, err
}

// ErrNotParked answers a retry or discard of an item that is not a parked
// item of the plugin.
var ErrNotParked = errors.New("plugindelivery: no such parked delivery")

// Retry returns a parked item to its subject's queue, behind the items that
// wait there now. It keeps its ID; its attempts start again.
func Retry(ctx context.Context, tx pgx.Tx, pluginID string, id uuid.UUID, now time.Time) (Parked, error) {
	rows, err := tx.Query(ctx, `UPDATE plugin_deliveries SET state='pending', parked_at=NULL, attempts=0, last_error=NULL,
			due_at=$3, next_attempt_at=$3, sequence=DEFAULT
		WHERE plugin_id=$1 AND id=$2 AND state='parked'
		RETURNING id,kind,source,subject,attempts,'',due_at,$3::timestamptz`, pluginID, id, now)
	if err != nil {
		return Parked{}, err
	}
	return oneParked(rows)
}

// Discard deletes a parked item.
func Discard(ctx context.Context, tx pgx.Tx, pluginID string, id uuid.UUID) (Parked, error) {
	rows, err := tx.Query(ctx, `DELETE FROM plugin_deliveries WHERE plugin_id=$1 AND id=$2 AND state='parked'
		RETURNING `+parkedColumns, pluginID, id)
	if err != nil {
		return Parked{}, err
	}
	return oneParked(rows)
}

func oneParked(rows pgx.Rows) (Parked, error) {
	items, err := pgx.CollectRows(rows, scanParked)
	if err != nil {
		return Parked{}, err
	}
	if len(items) == 0 {
		return Parked{}, ErrNotParked
	}
	return items[0], nil
}
