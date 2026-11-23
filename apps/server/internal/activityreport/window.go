package activityreport

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Querier is the database surface the reports use. A pool or a transaction
// satisfies it.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Reports runs the shared Activity reports against one database.
type Reports struct {
	db Querier
}

// New returns the reports for db.
func New(db Querier) *Reports { return &Reports{db: db} }

// DefaultRange is the window a report covers when the caller names neither
// end, and MaxRange the longest window any report accepts.
const (
	DefaultRange = 24 * time.Hour
	MaxRange     = 5 * 365 * 24 * time.Hour
)

// Window is a half-open reporting range [From, To).
type Window struct {
	From time.Time
	To   time.Time
}

// ErrInvalidWindow wraps every window validation failure. Its message is
// safe to show a caller.
var ErrInvalidWindow = errors.New("activity range is invalid")

type windowError struct{ message string }

func (e windowError) Error() string        { return e.message }
func (e windowError) Is(target error) bool { return target == ErrInvalidWindow }

// ParseWindow resolves RFC 3339 ends against now: a missing end defaults to
// the last DefaultRange, from must be earlier than to, and the range may not
// exceed MaxRange.
func ParseWindow(from, to string, now time.Time) (Window, error) {
	now = now.UTC()
	window := Window{From: now.Add(-DefaultRange), To: now}
	if value := strings.TrimSpace(from); value != "" {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return window, windowError{"from must be an RFC 3339 timestamp"}
		}
		window.From = parsed.UTC()
	}
	if value := strings.TrimSpace(to); value != "" {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return window, windowError{"to must be an RFC 3339 timestamp"}
		}
		window.To = parsed.UTC()
	}
	return window, window.Validate()
}

// Validate checks the ordering and the maximum range.
func (w Window) Validate() error {
	if !w.From.Before(w.To) {
		return windowError{"from must be earlier than to"}
	}
	if w.To.Sub(w.From) > MaxRange {
		return windowError{"activity ranges may not exceed five years"}
	}
	return nil
}
