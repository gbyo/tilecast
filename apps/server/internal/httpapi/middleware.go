package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

const dashboardContentSecurityPolicy = "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com/beacon.min.js; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://images.unsplash.com https://tiles.openfreemap.org; connect-src 'self' https://tiles.openfreemap.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

func (s *server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", dashboardContentSecurityPolicy)
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func (s *server) requestLog(next http.Handler) http.Handler {
	next = s.activityRoutes(s.loginBackgroundRoutes(s.previewRoutes(next)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		wrapped := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(wrapped, r)
		s.logger.Log(r.Context(), slog.LevelInfo, "HTTP request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", wrapped.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", middleware.GetReqID(r.Context()),
		)
	})
}

type rateEntry struct {
	count   int
	resetAt time.Time
}

type rateLimiter struct {
	mu          sync.Mutex
	entries     map[string]rateEntry
	limit       int
	duration    time.Duration
	lastCleanup time.Time
}

func newRateLimiter(limit int, duration time.Duration) *rateLimiter {
	return &rateLimiter{entries: make(map[string]rateEntry), limit: limit, duration: duration}
}

func (r *rateLimiter) allow(key string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lastCleanup.IsZero() || !now.Before(r.lastCleanup.Add(r.duration)) {
		for entryKey, entry := range r.entries {
			if !now.Before(entry.resetAt) {
				delete(r.entries, entryKey)
			}
		}
		r.lastCleanup = now
	}
	entry, ok := r.entries[key]
	if !ok || !now.Before(entry.resetAt) {
		r.entries[key] = rateEntry{count: 1, resetAt: now.Add(r.duration)}
		return true
	}
	if entry.count >= r.limit {
		return false
	}
	entry.count++
	r.entries[key] = entry
	return true
}

func (s *server) authRateLimit(next http.Handler) http.Handler {
	return s.rateLimit(s.authLimiter, false, next)
}

func (s *server) pairingRateLimit(next http.Handler) http.Handler {
	return s.rateLimit(s.pairingLimiter, false, next)
}

func (s *server) installRateLimit(next http.Handler) http.Handler {
	return s.rateLimit(s.installLimiter, false, next)
}

func (s *server) codeRateLimit(next http.Handler) http.Handler {
	return s.rateLimit(s.codeLimiter, true, next)
}

func (s *server) operationsRateLimit(next http.Handler) http.Handler {
	return s.rateLimit(s.operationsLimiter, true, next)
}

func (s *server) rateLimit(limiter *rateLimiter, includeUser bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.RemoteAddr
		if addrPort, err := netip.ParseAddrPort(r.RemoteAddr); err == nil {
			key = addrPort.Addr().String()
		}
		if includeUser {
			if principal, ok := principalOf(r); ok {
				key += ":" + principal.User.ID.String()
			}
		}
		if !limiter.allow(key, time.Now()) {
			retryAfter := int(limiter.duration / time.Second)
			if limiter.duration%time.Second != 0 {
				retryAfter++
			}
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many authentication attempts. Try again later.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// withAuditContext records the calling surface and request ID for the
// shared audit path. requireUser already names the surface for every
// credential it accepts, so this only fills narrow gaps: an unset surface
// on a session request is Studio, and a Studio surface on a grant
// credential is corrected to the grant's own. An unset surface on a
// non-session request is left unset so Record fails loudly instead of
// misattributing the row.
func (s *server) withAuditContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		switch audit.SurfaceFrom(ctx) {
		case "":
			if principal, ok := principalOf(r); ok && principal.CredentialKind == auth.CredentialKindSession {
				ctx = audit.WithSurface(ctx, audit.SurfaceStudio)
			}
		case audit.SurfaceStudio:
			if principal, ok := principalOf(r); ok && principal.CredentialKind == auth.CredentialKindGrant {
				ctx = audit.WithSurface(ctx, auditSurfaceForGrant(grantKindOf(principal), principal.ClientID))
			}
		}
		ctx = audit.WithRequest(ctx, middleware.GetReqID(ctx))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requireScreenScope refuses an operation on a screen outside the account's
// assigned scope.
//
// It is middleware rather than a check inside each handler so a screen route
// added later has to opt out of scoping deliberately rather than forget it. An
// unscoped account, and every Owner, passes through untouched.
func (s *server) requireScreenScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := principalOf(r)
		if !ok {
			// Fail closed. This middleware is only mounted inside the
			// authenticated subtree today, but the whole point is that a screen
			// route added later has to opt out of scoping deliberately, and
			// passing an unauthenticated request through would quietly undo that.
			writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
			return
		}
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			// Let the handler report a malformed id in its own words.
			next.ServeHTTP(w, r)
			return
		}
		if err := s.devices.AuthorizeScreen(r.Context(), principal.User.ID, principal.User.Role, id); err != nil {
			if errors.Is(err, devices.ErrOutOfScope) {
				// 404 rather than 403: a scoped operator has no business
				// learning which screens exist outside their scope.
				writeError(w, http.StatusNotFound, "screen_not_found", "Screen was not found.")
				return
			}
			s.internalError(w, r, err)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authorizeScreen is requireScreenScope for a screen named by something other
// than the {id} path parameter, such as the screen inside an update deployment.
// It returns false when it has already written the response.
func (s *server) authorizeScreen(w http.ResponseWriter, r *http.Request, screen uuid.UUID) bool {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
		return false
	}
	if err := s.devices.AuthorizeScreen(r.Context(), principal.User.ID, principal.User.Role, screen); err != nil {
		if errors.Is(err, devices.ErrOutOfScope) {
			// 404 for the same reason requireScreenScope reports one.
			writeError(w, http.StatusNotFound, "screen_not_found", "Screen was not found.")
			return false
		}
		s.internalError(w, r, err)
		return false
	}
	return true
}

// callerScope reports the account and whether it is narrowed, for the reads that
// have to filter their SQL rather than refuse outright. It returns false when it
// has already written the response.
func (s *server) callerScope(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool, bool) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
		return uuid.Nil, false, false
	}
	scoped, err := s.devices.Scoped(r.Context(), principal.User.ID, principal.User.Role)
	if err != nil {
		s.internalError(w, r, err)
		return uuid.Nil, false, false
	}
	return principal.User.ID, scoped, true
}

// resolveScreenTargets expands direct screens plus Display Group members into
// the concrete set that the screen-scope service authorizes. Keep expansion in
// one place so read filtering and write authorization cannot drift.
func (s *server) resolveScreenTargets(ctx context.Context, screens []uuid.UUID, groups []uuid.UUID) ([]uuid.UUID, error) {
	targets := append([]uuid.UUID(nil), screens...)
	if len(groups) == 0 {
		return targets, nil
	}
	rows, err := s.db.Query(ctx,
		`SELECT screen_id FROM screen_group_memberships WHERE screen_group_id = ANY($1)`, groups)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		targets = append(targets, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return targets, nil
}

// screenTargetsWithinScope is the non-rendering form used by list/read filters.
// A false result means at least one concrete screen is outside the account's
// scope; database failures remain errors rather than being mistaken for denial.
func (s *server) screenTargetsWithinScope(ctx context.Context, user uuid.UUID, role string, screens []uuid.UUID, groups []uuid.UUID) (bool, error) {
	targets, err := s.resolveScreenTargets(ctx, screens, groups)
	if err != nil {
		return false, err
	}
	if err = s.devices.AuthorizeScreens(ctx, user, role, targets); err != nil {
		if errors.Is(err, devices.ErrOutOfScope) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// authorizeScreenList checks a set of screens and groups named in a request
// body. It returns false when it has already written the response.
func (s *server) authorizeScreenList(w http.ResponseWriter, r *http.Request, screens []uuid.UUID, groups []uuid.UUID) bool {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
		return false
	}
	allowed, err := s.screenTargetsWithinScope(r.Context(), principal.User.ID, principal.User.Role, screens, groups)
	if err != nil {
		s.internalError(w, r, err)
		return false
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "out_of_scope",
			"Some of the selected screens are outside your assigned scope.")
		return false
	}
	return true
}
