package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// Outside Demo Mode the demo endpoints are not registered at all, so even a
// signed-in Owner with a valid CSRF token cannot reach a reset.
func TestDemoRoutesDoNotExistOutsideDemoMode(t *testing.T) {
	s := &server{logger: slog.New(slog.DiscardHandler)}
	router := s.routes()
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodPost, "/api/v1/demo/reset", nil),
		httptest.NewRequest(http.MethodGet, "/api/v1/demo", nil),
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404", request.Method, request.URL.Path, response.Code)
		}
	}
	if _, ok := s.demoSession(context.Background(), httptest.NewRecorder()); ok {
		t.Fatal("a demo session was issued outside Demo Mode")
	}
}

// The reset keeps the ordinary administrative checks: Owner role and CSRF.
func TestDemoResetRequiresOwnerAndCSRF(t *testing.T) {
	s := &server{logger: slog.New(slog.DiscardHandler)}
	reached := false
	handler := s.requireRoles("owner")(s.requireCSRF(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	})))
	for _, test := range []struct {
		role, token string
		want        int
	}{{"administrator", "token", http.StatusForbidden}, {"owner", "", http.StatusForbidden}, {"owner", "token", http.StatusOK}} {
		reached = false
		request := httptest.NewRequest(http.MethodPost, "/api/v1/demo/reset", nil)
		request.Header.Set("X-CSRF-Token", test.token)
		request = request.WithContext(context.WithValue(request.Context(), sessionContextKey, auth.Session{User: auth.User{Role: test.role}, CSRFToken: "token"}))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != test.want || reached != (test.want == http.StatusOK) {
			t.Errorf("role %s token %q: got %d reached=%v", test.role, test.token, response.Code, reached)
		}
	}
}
