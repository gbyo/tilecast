package auth

import (
	"context"

	"github.com/google/uuid"
)

// CredentialKind names the mechanism that authenticated a Principal.
// Sessions and user API grants (OAuth and personal access tokens) produce
// the same principal shape without changing the authorization model.
type CredentialKind string

const (
	// CredentialKindSession is a browser dashboard session cookie.
	CredentialKindSession CredentialKind = "session"
	// CredentialKindGrant is a user API grant: an OAuth access token or a
	// personal access token presented as a bearer credential.
	CredentialKindGrant CredentialKind = "grant"
)

// Principal is the authenticated Tilecast user behind a request, separate
// from the credential that proved them. Management authorization (role
// checks, screen scope, list scoping, actor rate limiting) reads the
// principal; only browser security ceremonies read the session itself.
type Principal struct {
	User User

	CredentialKind CredentialKind
	AuthMethod     string

	// GrantID, ClientID, ClientName, and ClientInstance identify a user API
	// grant and the client installation using it. They stay empty for
	// sessions.
	GrantID        *uuid.UUID
	ClientID       string
	ClientName     string
	ClientInstance string

	// Scopes bounds what a grant principal may ask for. Sessions carry the
	// user's full authority and leave this empty; grants intersect the live
	// user with this ceiling.
	Scopes []string

	// EnrollmentPending marks a principal that owes the organization a
	// second factor. It mirrors the session flag so a policy change can
	// never lock an installation out of itself.
	EnrollmentPending bool

	// Capabilities is the effective authority of the user's live role,
	// resolved on every request by the authentication boundary. Sessions and
	// grants resolve it the same way; a grant's scopes are a separate,
	// additional ceiling checked by requireScope.
	Capabilities CapabilitySet
}

// PrincipalFromSession derives the management principal from a dashboard
// session. The session stays the credential; the principal is the user.
func PrincipalFromSession(session Session) Principal {
	return Principal{
		User:              session.User,
		CredentialKind:    CredentialKindSession,
		AuthMethod:        session.AuthMethod,
		EnrollmentPending: session.EnrollmentPending,
	}
}

// PrincipalFromGrant derives the management principal from a user API
// grant. The user record is the live one read at use time, so disabling the
// account or changing its role or screen scope takes effect immediately;
// the grant contributes only its identity and scope ceiling.
func PrincipalFromGrant(user User, grantID uuid.UUID, clientID, clientName string, scopes []string, authMethod string) Principal {
	return Principal{
		User:           user,
		CredentialKind: CredentialKindGrant,
		AuthMethod:     authMethod,
		GrantID:        &grantID,
		ClientID:       clientID,
		ClientName:     clientName,
		Scopes:         scopes,
	}
}

// GrantsScope reports whether the principal may ask for scope. Sessions
// carry the user's full authority. Grants are hierarchical: admin implies
// write implies read.
func (p Principal) GrantsScope(scope string) bool {
	if p.CredentialKind != CredentialKindGrant {
		return true
	}
	has := map[string]bool{}
	for _, held := range p.Scopes {
		has[held] = true
	}
	switch scope {
	case "read":
		return has["read"] || has["write"] || has["admin"]
	case "write":
		return has["write"] || has["admin"]
	case "admin":
		return has["admin"]
	}
	return false
}

// Can reports whether the principal's role grants capability.
func (p Principal) Can(capability Capability) bool {
	return p.Capabilities.Has(capability)
}

// CanAny reports whether the principal holds at least one of capabilities.
func (p Principal) CanAny(capabilities ...Capability) bool {
	return p.Capabilities.HasAny(capabilities...)
}

// IsOwner reports whether the principal holds the built-in Owner role. Use it
// only where the Owner identity itself matters (the last-Owner invariant, an
// unscopable account), never as a stand-in for a capability.
func (p Principal) IsOwner() bool {
	return p.User.Role == RoleOwner
}

// Delegator returns the authority this principal can hand to others.
func (p Principal) Delegator() Delegator {
	return Delegator{UserID: p.User.ID, Role: p.User.Role, Capabilities: p.Capabilities}
}

type principalKey struct{}

// WithPrincipal attaches the management principal to the request context.
// requireUser calls it for every authenticated request, whether the
// credential was a session cookie or a bearer grant.
func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, principal)
}

// PrincipalFrom returns the request's management principal.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalKey{}).(Principal)
	return principal, ok
}
