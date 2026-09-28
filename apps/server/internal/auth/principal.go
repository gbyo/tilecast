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

// HasRole reports whether the principal carries one of the given roles.
func (p Principal) HasRole(roles ...string) bool {
	for _, role := range roles {
		if p.User.Role == role {
			return true
		}
	}
	return false
}

// CanManage reports whether the principal is an Owner or Administrator.
func (p Principal) CanManage() bool {
	return p.HasRole("owner", "administrator")
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
