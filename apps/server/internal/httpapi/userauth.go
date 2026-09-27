package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/oauth"
)

// requireUser is the management authentication boundary. It accepts either
// a valid enrolled browser session cookie or a valid user bearer token (an
// OAuth access token or a personal access token), and both produce the same
// auth.Principal. The credential source is explicit, never ambient: a
// request carrying an Authorization header is authenticated as that Bearer [REDACTED]
// or not at all; without the header, the session cookie is tried. a bearer credential never authenticates as a device or an
// integration token, and neither sessions nor grants cross into each
// other's endpoints: ceremonies that need the session itself keep an
// explicit requireSession behind this boundary.
func (s *server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if header := r.Header.Get("Authorization"); header != "" {
			s.requireBearer(w, r, header, next)
			return
		}
		cookie, err := r.Cookie(s.cookieName)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
			return
		}
		session, err := s.auth.Authenticate(r.Context(), cookie.Value)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
			return
		}
		ctx := context.WithValue(r.Context(), sessionContextKey, session)
		ctx = audit.WithSurface(ctx, audit.SurfaceStudio)
		next.ServeHTTP(w, r.WithContext(auth.WithPrincipal(ctx, auth.PrincipalFromSession(session))))
	})
}

// requireBearer authenticates one explicit Authorization header as a user
// Bearer [REDACTED] No other credential is consulted on this path.
func (s *server) requireBearer(w http.ResponseWriter, r *http.Request, header string, next http.Handler) {
	credential, ok := parseAuthorization(header, "Bearer")
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	grant, err := s.oauth.LookupBearer(r.Context(), credential)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user, err := s.activeUser(r.Context(), grant.UserID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if user.ID == uuid.Nil {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	pending, err := s.enrollmentPending(r.Context(), user, s.mfaPolicy(r))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	principal := auth.PrincipalFromGrant(user, grant.GrantID, grant.ClientID, grant.DisplayName, grant.Scopes, grant.BearerAuthMethod())
	principal.EnrollmentPending = pending
	ctx := audit.WithSurface(r.Context(), auditSurfaceForRequest(grant.Kind, grant.ClientID, r.UserAgent()))
	clientAttr := grant.ClientID
	if grant.Kind == oauth.BearerKindPAT {
		clientAttr = grant.DisplayName
	}
	ctx = audit.WithClient(ctx, clientAttr, "")
	next.ServeHTTP(w, r.WithContext(auth.WithPrincipal(ctx, principal)))
}

// activeUser loads the live user row for a bearer grant. Role, screen
// scope, and active flag are never snapshotted into the grant: disabling
// the account or changing its authority takes effect on the next request.
func (s *server) activeUser(ctx context.Context, id uuid.UUID) (auth.User, error) {
	var user auth.User
	var passwordHash string
	err := s.db.QueryRow(ctx, `SELECT id,name,username,password_hash,role,active,created_at,last_login_at FROM users WHERE id=$1 AND active=TRUE`, id).Scan(
		&user.ID, &user.Name, &user.Username, &passwordHash, &user.Role, &user.Active, &user.CreatedAt, &user.LastLoginAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.User{}, nil
	}
	if err != nil {
		return auth.User{}, err
	}
	return user, nil
}

// enrollmentPending mirrors the login-time enrollment gate for bearer
// credentials, so a user who owes the organization a second factor cannot
// walk around enrollment with a token. An unreadable policy value means
// "not required", exactly like the session path.
func (s *server) enrollmentPending(ctx context.Context, user auth.User, policy auth.MFAPolicy) (bool, error) {
	if !policy.AppliesTo(user.Role) {
		return false, nil
	}
	factors, err := s.auth.Factors(ctx, user.ID)
	if err != nil {
		return false, err
	}
	return !factors.Enrolled, nil
}

// auditSurfaceForGrant maps a user grant onto the closed audit surface
// vocabulary. Calling surface is attribution only and never changes
// authorization. OAuth grants name their first-party client: tilecast-cli
// is the CLI, tilecast-mcp is MCP. A personal access token can be used by
// any API client, so its kind alone proves nothing about the program that
// sent the request: every PAT is recorded as api.
func auditSurfaceForGrant(kind oauth.BearerKind, clientID string) audit.Surface {
	if kind == oauth.BearerKindPAT {
		return audit.SurfaceAPI
	}
	if clientID == oauth.ClientMCP {
		return audit.SurfaceMCP
	}
	return audit.SurfaceCLI
}

// The MCP subprocess can use the same stored CLI grant as other CLI
// commands. Its fixed agent identifies that calling surface for audit only;
// scopes, role, and token validity still come solely from the grant.
func auditSurfaceForRequest(kind oauth.BearerKind, clientID, agent string) audit.Surface {
	if kind == oauth.BearerKindOAuth && clientID == oauth.ClientCLI && agent == "tilecast-mcp" {
		return audit.SurfaceMCP
	}
	return auditSurfaceForGrant(kind, clientID)
}

// grantKindOf recovers the Bearer [REDACTED] family from a grant principal for
// attribution. The auth method label is set once at authentication time,
// so this mapping cannot drift from the credential that was presented.
func grantKindOf(principal auth.Principal) oauth.BearerKind {
	if principal.AuthMethod == "pat" {
		return oauth.BearerKindPAT
	}
	return oauth.BearerKindOAuth
}

// requireScope enforces the grant scope ceiling on one route. Sessions
// carry the user's full authority and always pass; grant principals must
// hold the scope, with admin implying write implying read. Every
// management route names the scope it needs, the same way integration
// routes name theirs.
func (s *server) requireScope(scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			principal, ok := principalOf(r)
			if !ok {
				writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
				return
			}
			if !principal.GrantsScope(scope) {
				writeError(w, http.StatusForbidden, "insufficient_scope", "This credential does not carry the required scope.")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
