package httpapi

import (
	"context"
	"net/http"
	"reflect"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// requestWithTestPrincipal attaches both a session and its derived
// management principal, mirroring what requireSession stores in production.
// Tests that inject only a session exercise nothing the server can produce.
func requestWithTestPrincipal(r *http.Request, session auth.Session) *http.Request {
	ctx := context.WithValue(r.Context(), sessionContextKey, session)
	return r.WithContext(auth.WithPrincipal(ctx, auth.PrincipalFromSession(session)))
}

// TestPrincipalContextRoundTrip pins the context plumbing the middleware relies on.
func TestPrincipalContextRoundTrip(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	if _, ok := auth.PrincipalFrom(r.Context()); ok {
		t.Fatal("bare request must not carry a principal")
	}
	want := auth.PrincipalFromSession(auth.Session{User: auth.User{Role: "owner"}})
	r = r.WithContext(auth.WithPrincipal(r.Context(), want))
	got, ok := auth.PrincipalFrom(r.Context())
	if !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip = %+v, %v; want %+v, true", got, ok, want)
	}
}
