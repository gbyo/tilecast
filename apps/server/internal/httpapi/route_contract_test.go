package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
	"github.com/tilecast/tilecast/apps/server/internal/backup"
	"github.com/tilecast/tilecast/apps/server/internal/campaigns"
	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
	"github.com/tilecast/tilecast/apps/server/internal/demo"
	"github.com/tilecast/tilecast/apps/server/internal/fleetops"
	"github.com/tilecast/tilecast/apps/server/internal/integrations"
	"github.com/tilecast/tilecast/apps/server/internal/notify"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/snapshots"
	bundled "github.com/tilecast/tilecast/plugins"
	"gopkg.in/yaml.v3"
)

// contractAllowlist names METHOD + path pairs that are intentionally
// outside the OpenAPI contract, each with the reason. It must stay empty:
// every ordinary /api/v1 transport is described in docs/openapi.yaml, and
// the parity test fails if an entry stops matching anything, so the list
// cannot go stale and cannot become a dumping ground.
var contractAllowlist = map[string]string{}

// normalizeRoutePattern drops Chi {name:regexp} constraints, which are an
// implementation detail; the contract names the parameter.
func normalizeRoutePattern(pattern string) string {
	var out strings.Builder
	for i := 0; i < len(pattern); i++ {
		if pattern[i] != '{' {
			out.WriteByte(pattern[i])
			continue
		}
		end := strings.IndexByte(pattern[i:], '}')
		if end < 0 {
			out.WriteString(pattern[i:])
			break
		}
		name := pattern[i+1 : i+end]
		if cut := strings.IndexByte(name, ':'); cut >= 0 {
			name = name[:cut]
		}
		out.WriteByte('{')
		out.WriteString(name)
		out.WriteByte('}')
		i += end
	}
	return out.String()
}

func walkChiRoutes(t *testing.T, handler http.Handler, routes map[string]bool) {
	t.Helper()
	walkable, ok := handler.(chi.Routes)
	if !ok {
		t.Fatalf("handler %T is not a chi router", handler)
	}
	err := chi.Walk(walkable, func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(pattern, "/api/v1") {
			return nil
		}
		routes[method+" "+normalizeRoutePattern(pattern)] = true
		return nil
	})
	if err != nil {
		t.Fatalf("walk production routes: %v", err)
	}
}

// productionV1Routes walks the actual production router, with the bundled
// plugins mounted exactly as the release mounts them. Optional services
// are present but empty: route registration only checks for nil and stores
// handler closures, so zero values register exactly the production paths.
// The preview and login-background sub-routers wrap the main router as
// middleware, so they are walked separately through the same builders the
// server wires in middleware.go.
func productionServerForRoutes() *server {
	s := &server{
		campaigns:            &campaigns.Service{},
		approvals:            &approvals.Service{},
		integrations:         &integrations.Service{},
		fleet:                &fleetops.Service{},
		contentHealthService: &contenthealth.Service{},
		notifications:        &notify.Service{},
		snapshots:            &snapshots.Service{},
		backups:              &backup.Service{},
		demo:                 &demo.Runtime{},
	}
	s.plugins = plugins.NewService(nil, nil, plugins.WithPlugins(bundled.Bundled()...))
	return s
}

func productionV1Routes(t *testing.T) map[string]bool {
	t.Helper()
	s := productionServerForRoutes()
	routes := map[string]bool{}
	walkChiRoutes(t, s.routes(), routes)
	// The sub-router builders take the fall-through handler as an
	// argument; a stub is enough because walking never serves requests.
	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	walkChiRoutes(t, s.previewRoutes(stub), routes)
	walkChiRoutes(t, s.loginBackgroundRoutes(stub), routes)
	return routes
}

// contractV1Operations reads the composed docs/openapi.yaml, the same
// document pluginctl generates and the Go client generates from.
func contractV1Operations(t *testing.T) map[string]bool {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test file")
	}
	dir := filepath.Dir(file)
	composed := filepath.Join(dir, "..", "..", "..", "..", "docs", "openapi.yaml")
	raw, err := os.ReadFile(composed)
	if err != nil {
		t.Fatalf("read composed OpenAPI: %v", err)
	}
	var doc struct {
		Paths map[string]map[string]any `yaml:"paths"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse composed OpenAPI: %v", err)
	}
	methods := map[string]bool{
		"GET": true, "PUT": true, "POST": true, "DELETE": true,
		"PATCH": true, "HEAD": true, "OPTIONS": true, "TRACE": true,
	}
	ops := map[string]bool{}
	for path, item := range doc.Paths {
		if !strings.HasPrefix(path, "/api/v1") {
			continue
		}
		for method := range item {
			if methods[strings.ToUpper(method)] {
				ops[strings.ToUpper(method)+" "+path] = true
			}
		}
	}
	return ops
}

// dispatcherV1Routes derives METHOD + path pairs from the same registry that
// activityRoutes uses to serve requests. That makes an undocumented branch or
// method change visible to the parity check instead of relying on a second list.
func dispatcherV1Routes(t *testing.T) map[string]bool {
	t.Helper()
	s := &server{}
	routes := map[string]bool{}
	for _, route := range s.activityDispatchRoutes() {
		key := route.method + " " + route.contractPath
		if routes[key] {
			t.Errorf("activity dispatcher registers %s more than once", key)
		}
		routes[key] = true
	}
	return routes
}

// TestRouteContractParity fails on served /api/v1 routes missing from
// OpenAPI and on OpenAPI operations with no production route. Parity
// problems are fixed by describing the route, never by generating handlers.
func TestRouteContractParity(t *testing.T) {
	served := productionV1Routes(t)
	for route := range dispatcherV1Routes(t) {
		served[route] = true
	}
	described := contractV1Operations(t)

	for route := range served {
		if _, ok := contractAllowlist[route]; ok {
			continue
		}
		if !described[route] {
			t.Errorf("route %s is served by the production server but missing from docs/openapi.yaml", route)
		}
	}
	for op := range described {
		if _, ok := contractAllowlist[op]; ok {
			continue
		}
		if !served[op] {
			t.Errorf("operation %s is described in docs/openapi.yaml but has no production server route", op)
		}
	}
	for route, reason := range contractAllowlist {
		if reason == "" {
			t.Errorf("allowlist entry %s needs a reason", route)
		}
		if !served[route] && !described[route] {
			t.Errorf("allowlist entry %s matches nothing; remove it", route)
		}
	}
}
