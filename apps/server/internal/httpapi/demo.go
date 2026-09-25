package httpapi

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/demo"
)

// Demo Mode's HTTP surface. None of it exists unless Dependencies.Demo is set,
// which only happens when TILECAST_ENV is demo: the routes are not registered
// and authStatus never issues a session.

// demoRoutes registers the demo endpoints behind the normal dashboard checks.
// The reset endpoint is destructive, so it also takes the Owner role and the
// session CSRF token like every other administrative mutation.
func (s *server) demoRoutes(dashboard chi.Router) {
	if s.demo == nil {
		return
	}
	dashboard.Get("/demo", s.demoState)
	dashboard.With(s.requireRoles("owner"), s.requireCSRF).Post("/demo/reset", s.resetDemo)
}

// demoSession signs a visitor in as the seeded Owner when the request has no
// valid session. It returns false outside Demo Mode.
func (s *server) demoSession(ctx context.Context, w http.ResponseWriter) (auth.Session, bool) {
	if s.demo == nil {
		return auth.Session{}, false
	}
	session, err := s.demo.Session(ctx)
	if err != nil {
		s.logger.Warn("demo session could not be issued", "error", err)
		return auth.Session{}, false
	}
	s.setSessionCookie(w, session)
	return session, true
}

func (s *server) demoState(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"data": s.demo.State()})
}

func (s *server) resetDemo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Scenario string `json:"scenario"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
	}
	state, err := s.demo.Reset(r.Context(), body.Scenario)
	if demo.IsUnknownScenario(err) {
		writeError(w, http.StatusUnprocessableEntity, "unknown_demo_scenario", err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// The reset removed every session, including this one. Issue the next one
	// now so the caller stays signed in.
	session, ok := s.demoSession(r.Context(), w)
	result := map[string]any{"state": state}
	if ok {
		result["csrfToken"] = session.CSRFToken
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}
