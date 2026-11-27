// Package durable is the claim and lease mechanism of durable Server work:
// rows that become due, are claimed by one Server process at a time, run
// outside the claiming transaction, and are completed or retried only by the
// claim that ran them. Plugin timers use it. It holds no queue semantics of
// its own: a table that uses it has the columns below and its own meaning.
//
//	id            UUID PRIMARY KEY
//	due_at        TIMESTAMPTZ NOT NULL
//	attempts      INTEGER NOT NULL
//	claim_token   UUID           (NULL when not claimed)
//	claimed_until TIMESTAMPTZ    (NULL when not claimed)
//	last_error    TEXT           (a stable code)
//
// A claim sets a random token and a lease. Another process can claim the
// row again only after the lease ends, for example after the first process
// stopped. Completion and retry name the row and the token, so a process
// that finishes after its lease was taken over changes nothing, and work
// that replaced the row (a new row with a new ID) is never touched.
package durable

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Queue is one table of durable work. Table is a constant of the caller,
// never input.
type Queue struct {
	Table string
}

// Claim is one claimed row.
type Claim struct {
	ID    uuid.UUID
	Token uuid.UUID
	// Attempt counts this claim: 1 for the first run.
	Attempt int
	// Until is the end of the lease.
	Until time.Time
}

// Filter narrows a claim to some rows. Where is SQL of the caller, never
// input; its parameters start at $4.
type Filter struct {
	Where string
	Args  []any
}

// Claim claims at most limit due rows that no live lease holds, oldest due
// first, with FOR UPDATE SKIP LOCKED: two processes never claim the same
// row at the same time.
func (q Queue) Claim(ctx context.Context, db queryer, now time.Time, lease time.Duration, limit int, filter Filter) ([]Claim, error) {
	token := uuid.New()
	until := now.Add(lease)
	where := ""
	if filter.Where != "" {
		where = " AND (" + filter.Where + ")"
	}
	sql := fmt.Sprintf(`UPDATE %[1]s SET claim_token=$1, claimed_until=$2, attempts=attempts+1
		WHERE id IN (SELECT id FROM %[1]s WHERE due_at<=$3 AND (claimed_until IS NULL OR claimed_until<=$3)%[2]s
			ORDER BY due_at, id LIMIT %[3]d FOR UPDATE SKIP LOCKED)
		RETURNING id, attempts`, q.Table, where, limit)
	args := append([]any{token, until, now}, filter.Args...)
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Claim, error) {
		claim := Claim{Token: token, Until: until}
		return claim, row.Scan(&claim.ID, &claim.Attempt)
	})
}

// Complete deletes a claimed row. It reports false when the claim no longer
// holds the row: the lease was taken over, or the row was replaced.
func (q Queue) Complete(ctx context.Context, db execer, claim Claim) (bool, error) {
	tag, err := db.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE id=$1 AND claim_token=$2`, q.Table), claim.ID, claim.Token)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Retry releases a claimed row to run again at due with a failure code. It
// reports false when the claim no longer holds the row.
func (q Queue) Retry(ctx context.Context, db execer, claim Claim, due time.Time, code string) (bool, error) {
	tag, err := db.Exec(ctx, fmt.Sprintf(`UPDATE %s SET due_at=$3, claim_token=NULL, claimed_until=NULL, last_error=$4
		WHERE id=$1 AND claim_token=$2`, q.Table), claim.ID, claim.Token, due, code)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Backoff is the bounded exponential delay before attempt+1: base after the
// first failure, doubling, never above max.
func Backoff(attempt int, base, max time.Duration) time.Duration {
	delay := base
	for i := 1; i < attempt && delay < max; i++ {
		delay *= 2
	}
	if delay > max {
		return max
	}
	return delay
}
