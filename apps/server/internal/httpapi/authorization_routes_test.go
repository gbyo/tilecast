package httpapi

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// TestScreenRoutesDeclareObjectAuthorization holds objectRules to the
// production router in both directions: every screen-domain route has a
// rule, and every rule names a route that exists. A screen route added
// with requireCapability and without an object rule stops the Server at
// startup, which this test turns into a failure.
func TestScreenRoutesDeclareObjectAuthorization(t *testing.T) {
	s := productionServerForRoutes()
	s.registeredObjectRules = map[string]bool{}
	var router http.Handler
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				t.Fatalf("building the router: %v", recovered)
			}
		}()
		router = s.routes()
	}()
	served := map[string]bool{}
	walkChiRoutes(t, router, served)
	for route := range served {
		method, pattern, _ := strings.Cut(route, " ")
		if inScreenDomain(pattern) {
			if _, ok := objectRules[method+" "+pattern]; !ok {
				t.Errorf("%s acts on screens but has no object rule", route)
			}
		}
	}
	stale := []string{}
	for key, rule := range objectRules {
		if !s.registeredObjectRules[key] {
			stale = append(stale, key)
		}
		if rule.kind == objectHandler && strings.TrimSpace(rule.note) == "" {
			t.Errorf("%s decides in its handler but does not say how", key)
		}
		if rule.kind != objectHandler && rule.capability == "" {
			t.Errorf("%s has an object rule without a capability", key)
		}
	}
	sort.Strings(stale)
	for _, key := range stale {
		t.Errorf("object rule %s matches no registered route; remove it", key)
	}
}

// TestGuardedRouterRefusesUndeclaredScreenRoutes is the startup guarantee
// itself: a new screen route without a declared rule cannot be mounted.
func TestGuardedRouterRefusesUndeclaredScreenRoutes(t *testing.T) {
	s := &server{}
	for _, pattern := range []string{"/screens/{id}/brand-new", "/screen-groups/{id}/brand-new", "/locations/{id}/brand-new", "/update-deployments/{id}/brand-new"} {
		func() {
			defer func() {
				recovered := recover()
				if recovered == nil || !strings.Contains(fmt.Sprint(recovered), "declares no object authorization") {
					t.Errorf("%s mounted without a rule (recovered %v)", pattern, recovered)
				}
			}()
			guarded := guardedRouter{Router: chi.NewRouter(), s: s, prefix: "/api/v1"}
			guarded.With().Post(pattern, func(http.ResponseWriter, *http.Request) {})
		}()
	}
	// A route outside the screen domain needs no rule.
	guarded := guardedRouter{Router: chi.NewRouter(), s: s, prefix: "/api/v1"}
	guarded.Get("/playlists/{id}/brand-new", func(http.ResponseWriter, *http.Request) {})
	// Routes must name a method, so nothing can be mounted around the guard.
	defer func() {
		if recover() == nil {
			t.Error("Handle without a method was accepted")
		}
	}()
	guarded.Handle("/screens/{id}", http.NotFoundHandler())
}
