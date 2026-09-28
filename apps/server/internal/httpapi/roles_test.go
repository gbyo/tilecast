package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

func TestRoleAuthorization(t *testing.T) {
	s := &server{}
	handler := s.requireRoles("owner", "administrator")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for _, test := range []struct {
		role string
		want int
	}{{"owner", http.StatusNoContent}, {"administrator", http.StatusNoContent}, {"editor", http.StatusForbidden}, {"viewer", http.StatusForbidden}} {
		request := httptest.NewRequest(http.MethodPost, "/", nil)
		request = requestWithTestPrincipal(request, auth.Session{User: auth.User{Role: test.role}})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != test.want {
			t.Errorf("role %s: got %d want %d", test.role, response.Code, test.want)
		}
	}
}
