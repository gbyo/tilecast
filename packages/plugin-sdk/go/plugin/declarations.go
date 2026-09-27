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
	if _, ok := p.(WorkerProvider); ok && !m.Capabilities.BackgroundWorkers {
		return fail("runs background workers without declaring capabilities.backgroundWorkers")
	}
	if provider, ok := p.(DataSourceProvider); ok {
		if err := checkDataSourceProvider(m, provider); err != nil {
			return err
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
	Method    string
	Pattern   string
	Access    Access
	RateLimit RateLimit
	Handler   Handler
}

var routeSegment = regexp.MustCompile(`^(?:[a-z0-9][a-z0-9._-]*|\{[a-zA-Z][a-zA-Z0-9]*\})$`)

type routeRecorder struct {
	manifest Manifest
	routes   []Route
	err      error
}

func (c *routeRecorder) Handle(method, pattern string, access Access, handler Handler) {
	c.HandleWithRateLimit(method, pattern, access, RateLimitNone, handler)
}

func (c *routeRecorder) HandleWithRateLimit(method, pattern string, access Access, rateLimit RateLimit, handler Handler) {
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
	if rateLimit != RateLimitNone && rateLimit != RateLimitOperations {
		fail("unsupported rate limit %q", rateLimit)
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
	c.routes = append(c.routes, Route{Method: method, Pattern: pattern, Access: access, RateLimit: rateLimit, Handler: handler})
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

// ProviderIDPattern is the stored shape of a plugin-owned Data Source
// provider identifier. The host enforces it again at composition, so a
// malformed contribution fails startup even when declaration checks are
// skipped.
var ProviderIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

var canonicalParamSegment = regexp.MustCompile(`^:[a-zA-Z][a-zA-Z0-9]*$`)

// checkDataSourceProvider validates the generic parts of a Data Source
// provider contribution: the stored provider identity, the gallery wording,
// and the canonical authoring routes against the plugin's declared Studio
// route ownership. Cross-plugin uniqueness and collisions with static core
// providers are composition checks the host runs at startup.
func checkDataSourceProvider(m Manifest, provider DataSourceProvider) error {
	fail := func(format string, args ...any) error {
		return fmt.Errorf("plugin %s: %s", m.ID, fmt.Sprintf(format, args...))
	}
	id := provider.ProviderID()
	if !ProviderIDPattern.MatchString(id) {
		return fail("malformed data source provider id %q: must match %s", id, ProviderIDPattern)
	}
	label, group, description := provider.Catalog()
	if strings.TrimSpace(label) == "" || strings.TrimSpace(group) == "" || strings.TrimSpace(description) == "" {
		return fail("data source provider %q needs a catalog label, group, and description", id)
	}
	for _, field := range []struct{ name, route string }{
		{"canonical editor", provider.CanonicalEditor()},
		{"canonical creator", provider.CanonicalCreator()},
	} {
		if field.route == "" {
			continue
		}
		if m.Studio == nil {
			return fail("data source provider %q names a %s route %q without declaring studio routes", id, field.name, field.route)
		}
		if err := checkCanonicalRoute(field.name, field.route, m.Studio); err != nil {
			return fail("%v", err)
		}
	}
	return nil
}

// checkCanonicalRoute requires a provider's canonical authoring route to be
// an absolute Studio path inside the plugin's declared route ownership: its
// management route, one of its additional routes, or below either. A single
// ":id" style parameter segment is allowed for the instance route.
func checkCanonicalRoute(field, route string, studio *StudioEntry) error {
	if !strings.HasPrefix(route, "/") || strings.Contains(route, "//") {
		return fmt.Errorf("data source %s route %q must be an absolute Studio path", field, route)
	}
	normalized := []string{}
	for _, segment := range strings.Split(strings.TrimPrefix(route, "/"), "/") {
		if canonicalParamSegment.MatchString(segment) {
			segment = "x"
		} else if !routeSegment.MatchString(segment) {
			return fmt.Errorf("data source %s route %q has unsupported segment %q", field, route, segment)
		}
		normalized = append(normalized, segment)
	}
	concrete := "/" + strings.Join(normalized, "/")
	owned := []string{studio.Route}
	owned = append(owned, studio.AdditionalRoutes...)
	for _, base := range owned {
		if concrete == base || strings.HasPrefix(concrete, base+"/") {
			return nil
		}
	}
	return fmt.Errorf("data source %s route %q is outside the plugin's declared studio routes", field, route)
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
