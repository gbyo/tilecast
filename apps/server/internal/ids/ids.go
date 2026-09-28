// Package ids allocates primary keys for newly created records.
//
// Every record gets a random UUID unless the caller's context names the key
// for the next record explicitly. Only in-process callers can do that: the
// context key is unexported and no request handler sets it, so an HTTP client
// can never choose an ID. Demo Mode uses it to give seeded records stable IDs
// while still creating them through the ordinary domain services.
package ids

import (
	"context"
	"sync"

	"github.com/google/uuid"
)

type contextKey struct{}

// fixed is consumed by the first New call that sees it, so a service that
// allocates several records in one operation gives the fixed ID only to the
// record created first and a random ID to every later one.
type fixed struct {
	mu   sync.Mutex
	id   uuid.UUID
	used bool
}

// WithNext returns a context whose next New call yields id.
func WithNext(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, contextKey{}, &fixed{id: id})
}

// New returns the ID a WithNext context reserved, once, and a random UUID
// otherwise.
func New(ctx context.Context) uuid.UUID {
	if reserved, ok := ctx.Value(contextKey{}).(*fixed); ok {
		reserved.mu.Lock()
		defer reserved.mu.Unlock()
		if !reserved.used {
			reserved.used = true
			return reserved.id
		}
	}
	return uuid.New()
}
