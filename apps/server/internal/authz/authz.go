// Package authz is the Server's object-level authorization layer.
//
// Role capabilities say what an account may do; they are resolved in
// internal/auth. This package answers the second half of every management
// decision: which specific screens, groups, schedules, takeovers,
// deployments, locations, and pairings the account may do it to. Every
// entry point (dashboard routes, Studio package-service calls, plugin
// routes) asks the same functions here, so equivalent operations cannot
// reach different answers.
//
// The rules, in one place because every caller depends on all of them:
//
//   - Deny by default. A decision needs both the capability and the object.
//     The capability is checked here too, not only in route middleware, so
//     an entry point that forgets its middleware still fails closed.
//   - Screen access is an explicit per-account policy: mode "all" or
//     "restricted". Restricted access is the union of the account's
//     location and Display Group grants. An account with no policy row
//     reaches no screen. The number of grant rows never decides the mode.
//   - The Owner always reaches every screen. An installation must not be
//     able to lock itself out of its own fleet.
//   - A container (Display Group, schedule, takeover, Quick Present,
//     AirPlay session, update deployment) is reachable by a restricted
//     account only through a concrete anchor. An empty container has no
//     anchor and is denied. Emptiness never authorizes anything.
//   - A set is all or nothing. A selection that names one object outside
//     the account's reach is refused whole; nothing is applied to the rest.
//   - Organization structure (Locations, Presentation Network definitions)
//     needs its own capability and access to the whole fleet, because
//     changing it can change what other accounts reach.
//
// Background work that acts for the installation (a package's install-time
// grant, a plugin's poller) does not carry an Actor and does not call this
// package. A Studio request always carries one.
package authz

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// Decision errors. Entry points translate them to their own transport:
// HTTP status codes for the dashboard, typed envelopes for package calls.
var (
	// ErrForbidden means the account's role lacks the capability.
	ErrForbidden = errors.New("your role does not allow this action")
	// ErrNotFound means the object does not exist or is outside the
	// account's reach. The two are indistinguishable on purpose: a
	// restricted operator has no business learning what exists elsewhere.
	ErrNotFound = errors.New("the requested resource was not found")
	// ErrOutOfScope means a selection names at least one object outside the
	// account's reach, or names nothing that could anchor the decision.
	ErrOutOfScope = errors.New("some of the selected screens are outside your screen access")
	// ErrRestricted means the action changes organization structure and
	// needs access to the whole fleet.
	ErrRestricted = errors.New("this action requires access to every screen")
	// ErrLocationRequired means a restricted account must place a new screen
	// into one of its granted locations.
	ErrLocationRequired = errors.New("choose a location within your screen access")
)

// Actor is the Studio account a decision is made for.
type Actor struct {
	UserID uuid.UUID
	// Owner is the built-in Owner role. It is the one role identity that
	// carries meaning of its own: an Owner always reaches every screen.
	Owner bool
	// Capabilities is the live role authority resolved for this request.
	Capabilities auth.CapabilitySet
}

// ActorFor builds the Actor of an authenticated principal.
func ActorFor(principal auth.Principal) Actor {
	return Actor{UserID: principal.User.ID, Owner: principal.IsOwner(), Capabilities: principal.Capabilities}
}

// ActorForRole builds an Actor from a user id, role key, and capability set,
// for entry points that carry them separately (package-service calls).
func ActorForRole(user uuid.UUID, role string, capabilities auth.CapabilitySet) Actor {
	return Actor{UserID: user, Owner: role == auth.RoleOwner, Capabilities: capabilities}
}

// Require returns ErrForbidden unless the actor holds every capability.
func Require(actor Actor, capabilities ...auth.Capability) error {
	if actor.UserID == uuid.Nil {
		return ErrForbidden
	}
	for _, capability := range capabilities {
		if !actor.Capabilities.Has(capability) {
			return ErrForbidden
		}
	}
	return nil
}

// Querier is the read side of a pool or transaction.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Authorizer makes object-level decisions against one database handle.
type Authorizer struct {
	db Querier
	// lock reads the policy row FOR SHARE, so a concurrent policy change
	// waits for the transaction that already passed the check.
	lock bool
}

// New returns an Authorizer that reads through db.
func New(db Querier) *Authorizer {
	return &Authorizer{db: db}
}

// Tx returns an Authorizer bound to tx. It locks the actor's policy row for
// the rest of the transaction, so a revocation either lands before the
// check or waits for the mutation that passed it.
func (z *Authorizer) Tx(tx pgx.Tx) *Authorizer {
	return &Authorizer{db: tx, lock: true}
}
