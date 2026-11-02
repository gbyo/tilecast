package services

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
)

// Studio calls act for the signed-in operator and get exactly the decision
// the equivalent dashboard route gets: the same capability and the same
// authz object rule. Background calls act for the installation under the
// package's install-time grant and take no user's screen access. The two
// are told apart by the call context alone; a Studio call that somehow
// lacks an actor is refused, never treated as background.

// studioActor returns the operator a Studio call acts for. studio is false
// for a background call.
func studioActor(call Call) (actor authz.Actor, studio bool, failure *CallError) {
	switch call.Context {
	case ContextStudio:
		if call.Actor == nil || call.Actor.UserID == uuid.Nil {
			return authz.Actor{}, true, forbidden("studio calls require an authenticated actor")
		}
		return authz.ActorForRole(call.Actor.UserID, call.Actor.Role, call.Actor.Capabilities), true, nil
	case ContextBackground:
		return authz.Actor{}, false, nil
	default:
		return authz.Actor{}, false, forbidden("unknown invocation context")
	}
}

func (d *Dispatcher) authorizer() *authz.Authorizer {
	return authz.New(d.deps.DB)
}

// authorize runs decide for a Studio call and passes a background call.
// notFoundMessage is what an object outside the operator's reach reads as.
func (d *Dispatcher) authorize(ctx context.Context, call Call, notFoundMessage string, decide func(*authz.Authorizer, authz.Actor) error) *CallError {
	actor, studio, failure := studioActor(call)
	if failure != nil || !studio {
		return failure
	}
	return authzFailure(decide(d.authorizer(), actor), notFoundMessage)
}

// screenAccess resolves the Studio operator's screen access for a list,
// after checking capability. A background call returns nil: the whole
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

// reachable filters ids for a Studio list with the same predicate the
// single-object decision uses. A background call keeps every id.
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

// requireCapability checks a Studio call's capability. It replaces the
// earlier studioCapability, which passed any call without an actor.
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
