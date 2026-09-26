package plugin

import (
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
)

// CheckDeclarations compares what a plugin implements with what its manifest
// declares, so the manifest is an honest description of the plugin. The host
// refuses to start a plugin that fails it, and plugintest.Conformance runs it
// in the plugin's own tests.
func CheckDeclarations(p Plugin) error {
	m := p.Manifest()
	fail := func(format string, args ...any) error {
		return fmt.Errorf("plugin %s: %s", m.ID, fmt.Sprintf(format, args...))
	}
	if err := m.Validate(); err != nil {
		return err
	}
	if _, ok := p.(ManifestProjector); ok {
		if !m.Capabilities.PlayerManifest {
			return fail("projects Player manifest entries without declaring capabilities.playerManifest")
		}
		if len(m.ManifestTypes()) == 0 {
			return fail("projects Player manifest entries without declaring runtime.manifestTypes")
		}
	}
	if _, ok := p.(AssetDependent); ok && !m.Capabilities.PlayerManifest {
		return fail("reports asset dependents without declaring capabilities.playerManifest")
	}
	if _, ok := p.(WorkerProvider); ok && !m.Capabilities.BackgroundWorkers {
		return fail("runs background workers without declaring capabilities.backgroundWorkers")
	}
	if consumer, ok := p.(HeartbeatConsumer); ok {
		declared := map[string]bool{}
		for _, name := range m.Capabilities.Heartbeat {
			declared[name] = true
		}
		for _, section := range consumer.HeartbeatSections() {
			if !declared[section.Name] || section.Handle == nil {
				return fail("consumes heartbeat section %q without declaring it", section.Name)
			}
		}
	}
	if provider, ok := p.(RouteProvider); ok {
		if m.API == nil {
			return fail("registers routes without declaring api.basePaths")
		}
		if _, err := CollectRoutes(m, provider); err != nil {
			return err
		}
	}
	if migrator, ok := p.(Migrator); ok && migrator.Migrations() != nil {
		if err := checkMigrations(migrator.Migrations()); err != nil {
			return fail("%v", err)
		}
	}
	return nil
}

// Route is one registered plugin route.
type Route struct {
	Method  string
	Pattern string
	Access  Access
	Handler Handler
}

var routeSegment = regexp.MustCompile(`^(?:[a-z0-9][a-z0-9._-]*|\{[a-zA-Z][a-zA-Z0-9]*\})$`)

type routeRecorder struct {
	manifest Manifest
	routes   []Route
	err      error
}

func (c *routeRecorder) Handle(method, pattern string, access Access, handler Handler) {
	if c.err != nil {
		return
	}
	fail := func(format string, args ...any) {
		c.err = fmt.Errorf("plugin %s: %s %s: %s", c.manifest.ID, method, pattern, fmt.Sprintf(format, args...))
	}
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead:
	default:
		fail("unsupported method")
		return
	}
	if access < AccessViewer || access > AccessSession {
		fail("no access level")
		return
	}
	if access == AccessViewer && method != http.MethodGet && method != http.MethodHead {
		fail("changes state with viewer access")
		return
	}
	if handler == nil {
		fail("no handler")
		return
	}
	for _, segment := range strings.Split(strings.TrimPrefix(pattern, "/"), "/") {
		if !routeSegment.MatchString(segment) {
			fail("unsupported segment %q; use plain segments and {name} parameters", segment)
			return
		}
	}
	inside := false
	for _, base := range c.manifest.API.BasePaths {
		if pattern == base || strings.HasPrefix(pattern, base+"/") {
			inside = true
		}
	}
	if !inside {
		fail("outside api.basePaths")
		return
	}
	// Within one plugin a literal may sit beside a parameter (the router
	// prefers the literal, and the plugin owns both), but two patterns with
	// one shape are the same route.
	for _, existing := range c.routes {
		if existing.Method == method && RouteShape(existing.Pattern) == RouteShape(pattern) {
			fail("registered twice (as %s)", existing.Pattern)
			return
		}
	}
	c.routes = append(c.routes, Route{Method: method, Pattern: pattern, Access: access, Handler: handler})
}

// CollectRoutes records and validates a plugin's routes. Patterns are below
// /api/v1 and must start with one of the manifest's api.basePaths.
func CollectRoutes(m Manifest, provider RouteProvider) ([]Route, error) {
	if m.API == nil {
		return nil, fmt.Errorf("plugin %s: registers routes without declaring api.basePaths", m.ID)
	}
	recorder := &routeRecorder{manifest: m}
	provider.Routes(recorder)
	return recorder.routes, recorder.err
}

var migrationFile = regexp.MustCompile(`^\d{5}_[a-z0-9_]+\.sql$`)

func checkMigrations(fsys fs.FS) error {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || path.Ext(entry.Name()) != ".sql" {
			continue
		}
		if !migrationFile.MatchString(entry.Name()) {
			return fmt.Errorf("migration %s is not named NNNNN_snake_case.sql", entry.Name())
		}
		content, err := fs.ReadFile(fsys, entry.Name())
		if err != nil {
			return err
		}
		text := string(content)
		if !strings.Contains(text, "-- +goose Up") || !strings.Contains(text, "-- +goose Down") {
			return fmt.Errorf("migration %s needs -- +goose Up and -- +goose Down sections", entry.Name())
		}
	}
	return nil
}
