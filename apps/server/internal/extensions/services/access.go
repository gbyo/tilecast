package services

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
)

// One rule decides who a call acts for, for packages and bundled plugins
// alike:
//
//   - A studio call acts for the signed-in operator and gets exactly the
//     decision the equivalent dashboard route gets: the live capability and
//     the same authz object rule. A studio call without an actor is refused,
//     never treated as unattended.
//   - A background or system call is unattended. It acts for the
//     installation under the caller's exact install-time service grant, sees
//     the installation-wide view the operation defines, and never carries
//     or borrows an operator, including the one who configured the plugin.
//     It runs only when the registry lists that context for the operation;
//     the dispatcher checks that before any handler runs.
//   - Any other context is refused.
//
// Unattended is not administrative: the grant names one versioned service,
// and the operation still applies its own resource rules.

// studioActor returns the operator a studio call acts for. studio is false
// for an unattended background or system call.
func studioActor(call Call) (actor authz.Actor, studio bool, failure *CallError) {
	switch call.Context {
	case ContextStudio:
		if call.Actor == nil || call.Actor.UserID == uuid.Nil {
			return authz.Actor{}, true, forbidden("studio calls require an authenticated actor")
		}
		return authz.ActorForRole(call.Actor.UserID, call.Actor.Role, call.Actor.Capabilities), true, nil
	case ContextBackground, ContextSystem:
		if call.Actor != nil {
			return authz.Actor{}, false, forbidden("unattended calls never act for an operator")
		}
		return authz.Actor{}, false, nil
	default:
		return authz.Actor{}, false, forbidden("unknown invocation context")
	}
}

func (d *Dispatcher) authorizer() *authz.Authorizer {
	return authz.New(d.deps.DB)
}

// authorize runs decide for a studio call and passes an unattended call.
// notFoundMessage is what an object outside the operator's reach reads as.
func (d *Dispatcher) authorize(ctx context.Context, call Call, notFoundMessage string, decide func(*authz.Authorizer, authz.Actor) error) *CallError {
	actor, studio, failure := studioActor(call)
	if failure != nil || !studio {
		return failure
	}
	return authzFailure(decide(d.authorizer(), actor), notFoundMessage)
}

// screenAccess resolves the studio operator's screen access for a list,
// after checking capability. An unattended call returns nil: the whole
// fleet under the install-time grant.
func (d *Dispatcher) screenAccess(ctx context.Context, call Call, capability auth.Capability) (*authz.ScreenAccess, *CallError) {
	actor, studio, failure := studioActor(call)
	if failure != nil || !studio {
		return nil, failure
	}
	if err := authz.Require(actor, capability); err != nil {
		return nil, authzFailure(err, "")
	}
	access, err := d.authorizer().Access(ctx, actor)
	if err != nil {
		return nil, unavailable(err)
	}
	return &access, nil
}

// reachable filters ids for a studio list with the same predicate the
// single-object decision uses. An unattended call keeps every id.
func (d *Dispatcher) reachable(ctx context.Context, call Call, capability auth.Capability, kind authz.Kind, ids []uuid.UUID) (map[uuid.UUID]bool, *CallError) {
	actor, studio, failure := studioActor(call)
	if failure != nil {
		return nil, failure
	}
	if !studio {
		all := make(map[uuid.UUID]bool, len(ids))
		for _, id := range ids {
			all[id] = true
		}
		return all, nil
	}
	visible, err := d.authorizer().Reachable(ctx, actor, capability, kind, ids)
	if err != nil {
		return nil, authzFailure(err, "")
	}
	return visible, nil
}

// requireCapability checks a studio call's capability and passes an
// unattended call.
func requireCapability(call Call, capability auth.Capability) *CallError {
	actor, studio, failure := studioActor(call)
	if failure != nil || !studio {
		return failure
	}
	return authzFailure(authz.Require(actor, capability), "")
}

// authzFailure maps a decision to the envelope, the way the dashboard maps
// it to status codes.
func authzFailure(err error, notFoundMessage string) *CallError {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, authz.ErrForbidden):
		return forbidden("this operation requires a capability the Studio role does not grant")
	case errors.Is(err, authz.ErrNotFound):
		if notFoundMessage == "" {
			notFoundMessage = "the requested resource was not found"
		}
		return notFound(notFoundMessage)
	case errors.Is(err, authz.ErrOutOfScope):
		return forbidden("some of the selected screens are outside your screen access")
	case errors.Is(err, authz.ErrRestricted):
		return forbidden("this operation requires access to every screen")
	case errors.Is(err, authz.ErrLocationRequired):
		return invalidInput("choose a location within your screen access")
	default:
		return unavailable(err)
	}
}
