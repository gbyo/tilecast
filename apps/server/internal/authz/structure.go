package authz

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// WholeFleet authorizes an action on organization structure: Location
// definitions, Presentation Network definitions, and anything else whose
// change redefines what other accounts reach. It needs the capabilities and
// access to every screen. A restricted account answers ErrRestricted even
// when its role holds the capability, the same way restructuring Media
// folders needs the whole library.
func (z *Authorizer) WholeFleet(ctx context.Context, actor Actor, capabilities ...auth.Capability) error {
	access, err := z.authorize(ctx, actor, capabilities...)
	if err != nil {
		return err
	}
	if !access.All {
		return ErrRestricted
	}
	return nil
}

// AssignLocation authorizes placing a screen into a location: a new screen
// at pairing, a restored screen, or a screen moved by an edit. A location
// is a scope anchor for other accounts, so a restricted account may use only
// a location granted to it directly. A Display Group grant never authorizes
// a location, and a restricted account may not leave a screen without one.
func (z *Authorizer) AssignLocation(ctx context.Context, actor Actor, capability auth.Capability, location *uuid.UUID) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	if location == nil || *location == uuid.Nil {
		return ErrLocationRequired
	}
	if !access.Configured {
		return ErrNotFound
	}
	return z.found(ctx, `SELECT `+locationGrantSQL("$2", "$1"), actor.UserID, *location)
}

// PairingKind is what an approval does to the fleet.
type PairingKind string

const (
	// PairingNew creates a screen for hardware Tilecast has not seen.
	PairingNew PairingKind = "new_screen"
	// PairingRestore re-provisions an archived screen record. Revocation
	// detached it from every location and group, so it has no anchor of its
	// own and follows the new-screen rule.
	PairingRestore PairingKind = "restore"
	// PairingRepair replaces the credential of an existing screen.
	PairingRepair PairingKind = "credential_repair"
	// PairingReplacement moves an existing logical screen onto new hardware.
	PairingReplacement PairingKind = "hardware_replacement"
)

// PairingTarget is what one approval would change.
type PairingTarget struct {
	Kind PairingKind
	// ScreenID is the existing screen for repair and replacement.
	ScreenID uuid.UUID
	// LocationID is the destination for a new or restored screen.
	LocationID *uuid.UUID
}

// Pairing authorizes one pairing approval. A new or restored screen needs a
// destination the account administers; repair and replacement need the
// existing logical screen. Call it inside the approval transaction.
func (z *Authorizer) Pairing(ctx context.Context, actor Actor, target PairingTarget) error {
	switch target.Kind {
	case PairingNew, PairingRestore:
		return z.AssignLocation(ctx, actor, auth.CapScreenPair, target.LocationID)
	case PairingRepair, PairingReplacement:
		return z.Screen(ctx, actor, auth.CapScreenPair, target.ScreenID)
	default:
		return fmt.Errorf("authz: unknown pairing kind %q", target.Kind)
	}
}

// PairingSessionSQL is the predicate "this device_pairing_sessions row is
// visible in the pending list". A restricted account sees only sessions
// from hardware already paired to one of its live screens; brand-new
// hardware has no anchor until an approval names a destination, so it is
// reached only through its pairing code.
func (a ScreenAccess) PairingSessionSQL(alias, userParam string) string {
	return a.policySQL(userParam, `EXISTS(SELECT 1 FROM screens authz_ps
	       WHERE authz_ps.player_installation_id=` + alias + `.player_installation_id
	         AND authz_ps.deleted_at IS NULL AND authz_ps.archived_at IS NULL
	         AND ` + grantedScreenSQL("authz_ps", userParam) + `)`)
}

// PairingCodeSQL is the predicate "this session may be resolved by its
// code". Holding the code is the anchor for new hardware; a session from
// hardware paired to a live screen also needs that screen to be reachable.
func (a ScreenAccess) PairingCodeSQL(alias, userParam string) string {
	return a.policySQL(userParam, `(NOT EXISTS(SELECT 1 FROM screens authz_pl
	       WHERE authz_pl.player_installation_id=` + alias + `.player_installation_id
	         AND authz_pl.deleted_at IS NULL AND authz_pl.archived_at IS NULL)
	OR ` + a.PairingSessionSQL(alias, userParam) + `)`)
}

// PairingSession authorizes resolving or rejecting one pairing session.
// rejection is true for a reject: a restricted account may reject only a
// session from hardware already paired to one of its screens, because a
// rejection of new hardware has no destination to anchor it.
func (z *Authorizer) PairingSession(ctx context.Context, actor Actor, capability auth.Capability, id uuid.UUID, rejection bool) error {
	access, err := z.authorize(ctx, actor, capability)
	if err != nil || access.All {
		return err
	}
	predicate := access.PairingCodeSQL("p", "$1")
	if rejection {
		predicate = access.PairingSessionSQL("p", "$1")
	}
	return z.found(ctx, `SELECT EXISTS(SELECT 1 FROM device_pairing_sessions p WHERE p.id=$2 AND `+predicate+`)`, actor.UserID, id)
}
