package plugins

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

type routedPlugin struct {
	plugin.Bundle
	routes []string // "METHOD /pattern"
}

func (p routedPlugin) Routes(router plugin.Router) {
	for _, route := range p.routes {
		method, pattern, _ := strings.Cut(route, " ")
		router.Handle(method, pattern, plugin.AccessSession, func(http.ResponseWriter, *http.Request) error { return nil })
	}
}

func newRoutedPlugin(id, base string, routes ...string) routedPlugin {
	manifest := fmt.Sprintf(`{"apiVersion":1,"id":%q,"definitionVersion":1,"name":%q,
		"description":"Routes only.","category":"Workflow","icon":"puzzle","maintainers":["@gbyo"],
		"instanceNoun":{"singular":"item","plural":"items"},"server":{"entrypoint":"./plugin.go"},
		"api":{"basePaths":[%q],"openapi":"./api/openapi.yaml"}}`, id, id, base)
	return routedPlugin{Bundle: plugin.NewBundle([]byte(manifest), nil), routes: routes}
}

// Plugins cannot answer one path between them. The host compares route
// shapes, so a parameter collides with a literal and parameter names do not
// matter. (pluginctl also refuses overlapping api.basePaths; the host does not
// rely on it.)
func TestRoutesRefuseOverlapBetweenPlugins(t *testing.T) {
	for _, tc := range []struct {
		name     string
		a, b     []string
		conflict bool
	}{
		{"exact duplicate", []string{"GET /plugins/shared/{id}"}, []string{"GET /plugins/shared/{id}"}, true},
		{"parameter name only", []string{"GET /plugins/shared/{id}"}, []string{"GET /plugins/shared/{name}"}, true},
		{"literal and parameter", []string{"GET /plugins/shared/{id}"}, []string{"GET /plugins/shared/install"}, true},
		{"nested", []string{"POST /plugins/shared/{id}/items/{item}"}, []string{"POST /plugins/shared/a/items/b"}, true},
		{"different methods", []string{"GET /plugins/shared/{id}"}, []string{"DELETE /plugins/shared/{id}"}, false},
		{"valid siblings", []string{"GET /plugins/shared/one"}, []string{"GET /plugins/shared/two"}, false},
		{"different depth", []string{"GET /plugins/shared/{id}"}, []string{"GET /plugins/shared/{id}/items"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := NewService(nil, nil, WithPlugins(
				newRoutedPlugin("alpha_routes", "/plugins/shared", tc.a...),
				newRoutedPlugin("beta_routes", "/plugins/shared", tc.b...),
			))
			_, err := service.Routes()
			if tc.conflict && (err == nil || !strings.Contains(err.Error(), "overlaps")) {
				t.Fatalf("expected an overlap error, got %v", err)
			}
			if !tc.conflict && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
