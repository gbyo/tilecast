package plugin

import (
	"net/http"
	"strings"
	"testing"
)

func TestRoutePatternsOverlap(t *testing.T) {
	for _, tc := range []struct {
		a, b    string
		overlap bool
	}{
		{"/things/{id}", "/things/{id}", true},
		{"/things/{id}", "/things/{name}", true},
		{"/things/{id}", "/things/install", true},
		{"/things/install", "/things/{id}", true},
		{"/things/{id}/items/{item}", "/things/abc/items/{x}", true},
		{"/things/{id}/items", "/things/{id}/other", false},
		{"/things/install", "/things/remove", false},
		{"/things", "/things/{id}", false},
		{"/things/{id}", "/stuff/{id}", false},
	} {
		if got := RoutePatternsOverlap(tc.a, tc.b); got != tc.overlap {
			t.Errorf("RoutePatternsOverlap(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.overlap)
		}
	}
	if RouteShape("/a/{id}/b/{name}") != "/a/{}/b/{}" {
		t.Fatalf("shape = %q", RouteShape("/a/{id}/b/{name}"))
	}
}

type routesFunc func(Router)

func (f routesFunc) Routes(router Router) { f(router) }

func TestCollectRoutesRefusesOneShapeTwice(t *testing.T) {
	manifest := Manifest{ID: "sample", API: &APIEntry{BasePaths: []string{"/plugins/sample"}}}
	handler := func(http.ResponseWriter, *http.Request) error { return nil }
	_, err := CollectRoutes(manifest, routesFunc(func(r Router) {
		r.Handle(http.MethodGet, "/plugins/sample/items/{id}", AccessViewer, handler)
		r.Handle(http.MethodGet, "/plugins/sample/items/{name}", AccessViewer, handler)
	}))
	if err == nil || !strings.Contains(err.Error(), "registered twice") {
		t.Fatalf("param-name-only duplicate: %v", err)
	}
	routes, err := CollectRoutes(manifest, routesFunc(func(r Router) {
		r.Handle(http.MethodGet, "/plugins/sample/items/{id}", AccessViewer, handler)
		r.Handle(http.MethodGet, "/plugins/sample/items/export", AccessViewer, handler)
		r.Handle(http.MethodDelete, "/plugins/sample/items/{id}", AccessManager, handler)
	}))
	if err != nil || len(routes) != 3 {
		t.Fatalf("valid siblings: %v %d", err, len(routes))
	}
}
