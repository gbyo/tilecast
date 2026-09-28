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

// dispatchedExact names METHOD + path pairs served by the activityRoutes
// dispatcher (activity_routes.go), which multiplexes inside a middleware
// handler where chi.Walk cannot see them. The test requires every entry to
// occur as a string literal in activity_routes.go, so a removed dispatcher
// path fails instead of going stale.
var dispatchedExact = map[string]string{
	"POST /api/v1/player/liveness":                  "device liveness without a playback snapshot",
	"POST /api/v1/player/telemetry":                 "device telemetry ingest",
	"POST /api/v1/player/activity-events":           "device activity event ingest",
	"GET /api/v1/activity/overview":                 "fleet activity overview",
	"GET /api/v1/activity/uptime":                   "fleet uptime",
	"GET /api/v1/activity/proof-of-play":            "proof-of-play listing",
	"GET /api/v1/activity/proof-of-play/summary":    "proof-of-play summary",
	"GET /api/v1/activity/proof-of-play/export.csv": "proof-of-play CSV export",
	"GET /api/v1/activity/screen-events":            "screen event listing",
	"GET /api/v1/activity/audit":                    "audit activity listing",
	"GET /api/v1/activity/audit/export.csv":         "audit activity CSV export",
	"GET /api/v1/activity/compliance":               "playback compliance",
	"GET /api/v1/activity/incidents":                "incident listing",
	"GET /api/v1/activity/incidents/analytics":      "incident analytics",
	"GET /api/v1/activity/retention":                "activity retention policy",
	"PATCH /api/v1/activity/retention":              "activity retention update",
}

// dispatchedPrefix covers dispatcher-served contract operations below a
// path prefix, with the methods the dispatcher answers there. Prefix
// literals must likewise occur in activity_routes.go.
var dispatchedPrefix = map[string]map[string]string{
	"/api/v1/activity/screens/": {
		"GET": "per-screen timelines, telemetry, and activity",
	},
	"/api/v1/activity/incidents/": {
		"GET":   "single incident fetch",
		"PATCH": "incident update",
	},
}

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
func productionV1Routes(t *testing.T) map[string]bool {
	t.Helper()
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

// dispatcherSource returns activity_routes.go so the test can verify every
// dispatched entry still exists there as a string literal.
func dispatcherSource(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test file")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "activity_routes.go"))
	if err != nil {
		t.Fatalf("read activity dispatcher: %v", err)
	}
	return string(raw)
}

func dispatched(t *testing.T, op string) bool {
	t.Helper()
	if _, ok := dispatchedExact[op]; ok {
		return true
	}
	method, path, found := strings.Cut(op, " ")
	if !found {
		return false
	}
	for prefix, methods := range dispatchedPrefix {
		if _, ok := methods[method]; ok && strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

// TestRouteContractParity fails on registered /api/v1 routes missing from
// OpenAPI and on OpenAPI operations with no built server route. Parity
// problems are fixed by describing the route, never by generating handlers.
func TestRouteContractParity(t *testing.T) {
	registered := productionV1Routes(t)
	described := contractV1Operations(t)
	source := dispatcherSource(t)
	for route := range registered {
		if _, ok := contractAllowlist[route]; ok {
			continue
		}
		if !described[route] {
			t.Errorf("route %s is registered by the production server but missing from docs/openapi.yaml", route)
		}
	}
	for op := range described {
		if _, ok := contractAllowlist[op]; ok {
			continue
		}
		if !registered[op] && !dispatched(t, op) {
			t.Errorf("operation %s is described in docs/openapi.yaml but has no production server route", op)
		}
	}
	for route, reason := range contractAllowlist {
		if reason == "" {
			t.Errorf("allowlist entry %s needs a reason", route)
		}
		if !registered[route] && !described[route] {
			t.Errorf("allowlist entry %s matches nothing; remove it", route)
		}
	}
	// Every dispatched entry must still exist in the dispatcher source and
	// must match at least one described operation.
	for op, reason := range dispatchedExact {
		if reason == "" {
			t.Errorf("dispatched entry %s needs a reason", op)
		}
		_, path, _ := strings.Cut(op, " ")
		if !strings.Contains(source, `"`+path+`"`) {
			t.Errorf("dispatched entry %s no longer occurs in activity_routes.go; remove it", op)
		}
		if !described[op] {
			t.Errorf("dispatched entry %s has no docs/openapi.yaml operation; describe it", op)
		}
	}
	for prefix, methods := range dispatchedPrefix {
		if !strings.Contains(source, `"`+prefix+`"`) {
			t.Errorf("dispatched prefix %s no longer occurs in activity_routes.go; remove it", prefix)
		}
		for method, reason := range methods {
			if reason == "" {
				t.Errorf("dispatched prefix %s %s needs a reason", method, prefix)
			}
			matched := false
			for op := range described {
				m, path, _ := strings.Cut(op, " ")
				if m == method && strings.HasPrefix(path, prefix) {
					matched = true
					break
				}
			}
			if !matched {
				t.Errorf("dispatched prefix %s %s matches no docs/openapi.yaml operation", method, prefix)
			}
		}
	}
}
