package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// The host compares route shapes against the registered Chi tree instead of
// probing it with one sample path per plugin route.
func TestCheckPluginRoutesComparesShapes(t *testing.T) {
	ok := func(http.ResponseWriter, *http.Request) {}
	core := chi.NewRouter()
	core.Get("/things/install", ok)
	core.Get("/foo/{id}", ok)
	core.Post("/foo/{id}", ok)
	core.Route("/nested", func(r chi.Router) {
		r.Get("/{id}/items", ok)
	})
	core.Get("/numbers/{n:[0-9]+}", ok)
	core.Get("/files/{name}.json", ok)
	core.Mount("/static", http.HandlerFunc(ok))

	for _, tc := range []struct {
		name     string
		method   string
		pattern  string
		conflict bool
	}{
		{"exact duplicate", http.MethodGet, "/foo/{id}", true},
		{"parameter name only", http.MethodGet, "/foo/{name}", true},
		{"plugin parameter over core literal", http.MethodGet, "/things/{id}", true},
		{"plugin literal under core parameter", http.MethodGet, "/foo/install", true},
		{"nested route", http.MethodGet, "/nested/{thing}/items", true},
		{"nested literal", http.MethodGet, "/nested/abc/items", true},
		{"regexp parameter matches", http.MethodGet, "/numbers/42", true},
		{"regexp parameter refuses", http.MethodGet, "/numbers/latest", false},
		{"partial segment parameter", http.MethodGet, "/files/report.json", true},
		{"partial segment mismatch", http.MethodGet, "/files/report", false},
		{"mounted wildcard", http.MethodGet, "/static/{file}", true},
		{"different method", http.MethodDelete, "/foo/{id}", false},
		{"valid sibling", http.MethodGet, "/things/uninstall", false},
		{"different depth", http.MethodGet, "/foo/{id}/items", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := checkPluginRoutes(core, []plugins.Route{{PluginID: "sample", Method: tc.method, Pattern: tc.pattern}})
			if tc.conflict && (err == nil || !strings.Contains(err.Error(), "overlaps the core route")) {
				t.Fatalf("expected a core overlap, got %v", err)
			}
			if !tc.conflict && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
