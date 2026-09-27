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
// auth.Principal. A session cookie is tried first so Studio keeps working
// unchanged; a bearer credential never authenticates as a device or an
// integration token, and neither sessions nor grants cross into each
// other's endpoints: ceremonies that need the session itself keep an
// explicit requireSession behind this boundary.
func (s *server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cookie, err := r.Cookie(s.cookieName); err == nil {
			if session, err := s.auth.Authenticate(r.Context(), cookie.Value); err == nil {
				ctx := context.WithValue(r.Context(), sessionContextKey, session)
				next.ServeHTTP(w, r.WithContext(auth.WithPrincipal(ctx, auth.PrincipalFromSession(session))))
				return
			}
		}
		credential, ok := parseAuthorization(r.Header.Get("Authorization"), "Bearer")
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
		principal := auth.PrincipalFromGrant(user, grant.GrantID, grant.ClientPublicID, grant.ClientName, grant.Scopes, grant.BearerAuthMethod())
		principal.EnrollmentPending = pending
		ctx := audit.WithSurface(r.Context(), auditSurfaceForGrant(grant.ClientName))
		ctx = audit.WithClient(ctx, grant.ClientPublicID, "")
		next.ServeHTTP(w, r.WithContext(auth.WithPrincipal(ctx, principal)))
	})
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

// auditSurfaceForGrant maps a grant client onto the closed audit surface
// vocabulary. The CLI, its OAuth tokens, and personal access tokens are all
// remote API operators; MCP agents keep their own surface.
func auditSurfaceForGrant(clientName string) audit.Surface {
	if clientName == oauth.ClientMCP {
		return audit.SurfaceMCP
	}
	return audit.SurfaceCLI
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
