package demo

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestDemoDeadlockRetry(t *testing.T) {
	for _, test := range []struct {
		name      string
		err       error
		failures  int
		wantCalls int
	}{
		{"aborted transaction recovers", fmt.Errorf("truncate: %w", &pgconn.PgError{Code: "40P01"}), 1, 2},
		{"persistent deadlock is bounded", &pgconn.PgError{Code: "40P01"}, 5, 3},
		{"lock timeout is reported", &pgconn.PgError{Code: "55P03"}, 1, 1},
		{"ambiguous connection failure is reported", errors.New("connection closed during commit"), 1, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			err := retryDemoDeadlock(context.Background(), func() error {
				calls++
				if calls <= test.failures {
					return test.err
				}
				return nil
			})
			if calls != test.wantCalls {
				t.Fatalf("calls = %d, want %d", calls, test.wantCalls)
			}
			if calls <= test.failures && !errors.Is(err, test.err) {
				t.Fatalf("error = %v, want original failure", err)
			}
			if calls > test.failures && err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDemoDeadlockRetryCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	err := retryDemoDeadlock(ctx, func() error {
		calls++
		cancel()
		return &pgconn.PgError{Code: "40P01"}
	})
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("error = %v, calls = %d; want cancellation without another transaction", err, calls)
	}
}
