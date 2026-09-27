// Package pluginharness runs one plugin against a migrated Tilecast database
// and the real plugin host, for that plugin's own integration tests. It is to
// Tilecast what a test harness is to any host application: the one Tilecast
// Server package that plugin tests may import, and only from _test.go files
// (`npm run plugins:check` enforces this). Production plugin code depends on
// the plugin SDK alone.
//
// A harness needs TEST_DATABASE_URL and skips the test without it. It holds
// the same advisory lock as the server's integration tests, so packages
// never truncate each other's fixtures.
package pluginharness

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Harness is one plugin hosted on a fresh organization.
type Harness struct {
	Ctx     context.Context
	Pool    *pgxpool.Pool
	Host    plugin.Host
	OrgID   uuid.UUID
	OwnerID uuid.UUID

	t       *testing.T
	id      string
	service *plugins.Service
}

// Option adjusts how a Harness is built.
type Option func(*options)

type options struct{ maxConnections int }

// MaxConnections bounds the plugin's database pool. With 1, a plugin that
// reads through the pool while its own transaction holds the only connection
// blocks, so a test can prove that a write path never does that.
func MaxConnections(n int) Option {
	return func(o *options) { o.maxConnections = n }
}

// New migrates the test database, empties it, creates an organization and an
// Owner, and hosts p. The plugin is initialized but not installed.
func New(t *testing.T, p plugin.Plugin, opts ...Option) *Harness {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	var chosen options
	for _, opt := range opts {
		opt(&chosen)
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lockPool.Close)
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lock.Release)
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) })
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	poolURL := databaseURL
	if chosen.maxConnections > 0 {
		parsed, parseErr := url.Parse(databaseURL)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		query := parsed.Query()
		query.Set("pool_max_conns", strconv.Itoa(chosen.maxConnections))
		parsed.RawQuery = query.Encode()
		poolURL = parsed.String()
	}
	pool, err := database.Open(ctx, poolURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users,plugin_installations CASCADE`); err != nil {
		t.Fatal(err)
	}
	h := &Harness{Ctx: ctx, Pool: pool, OrgID: uuid.New(), OwnerID: uuid.New(), t: t, id: p.Manifest().ID}
	h.exec(`INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Plugin Harness',$1)`, h.OrgID)
	h.exec(`INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','harness-owner','unused','owner',TRUE)`, h.OwnerID)
	h.service = plugins.NewService(pool, nil, plugins.WithPlugins(p))
	h.Host, _ = h.service.Host(h.id)
	return h
}

func (h *Harness) exec(query string, args ...any) {
	h.t.Helper()
	if _, err := h.Pool.Exec(h.Ctx, query, args...); err != nil {
		h.t.Fatalf("%s: %v", query, err)
	}
}

// Install installs the plugin through the core lifecycle.
func (h *Harness) Install() {
	h.t.Helper()
	if _, _, err := h.service.Install(h.Ctx, h.id, h.OwnerID); err != nil {
		h.t.Fatal(err)
	}
}

// Remove removes the plugin's installation through the core lifecycle. A
// plugin that still owns resources answers with a *plugins.InUseError.
func (h *Harness) Remove() error {
	return h.service.Remove(h.Ctx, h.id, h.OwnerID)
}

// Status is the plugin's catalog entry as the API reports it.
type Status struct {
	Installed     bool
	Configured    bool
	Active        bool
	InstanceCount int
	Attention     []string
}

// Status reads the plugin's catalog entry.
func (h *Harness) Status() Status {
	h.t.Helper()
	item, err := h.service.CatalogItem(h.Ctx, h.id)
	if err != nil {
		h.t.Fatal(err)
	}
	status := Status{Installed: item.Installed, Configured: item.Configured, Active: item.Active, InstanceCount: item.InstanceCount}
	for _, note := range item.Attention {
		status.Attention = append(status.Attention, note.Code)
	}
	return status
}

// Manifest projects the plugin for one screen through the host, including
// the installation gate and the declared-type check.
func (h *Harness) Manifest(screenID uuid.UUID) []plugin.ManifestEntry {
	h.t.Helper()
	entries, err := h.service.ManifestForScreen(h.Ctx, screenID)
	if err != nil {
		h.t.Fatal(err)
	}
	return entries
}

// ScreenOption adjusts a screen before it is created.
type ScreenOption func(*screen)

type screen struct {
	platform string
	location *uuid.UUID
}

// Platform sets the screen's Player platform (the default is linux).
func Platform(name string) ScreenOption { return func(s *screen) { s.platform = name } }

// AtLocation places the screen at a location.
func AtLocation(id uuid.UUID) ScreenOption { return func(s *screen) { s.location = &id } }

// Screen creates a paired screen with a manifest state row.
func (h *Harness) Screen(name string, options ...ScreenOption) uuid.UUID {
	h.t.Helper()
	config := screen{platform: "linux"}
	for _, option := range options {
		option(&config)
	}
	id := uuid.New()
	h.exec(`INSERT INTO screens(id,organization_id,player_installation_id,name,location_id,platform,
		device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
		VALUES($1,$2,$3,$4,$5,$6,'Test','Display','Test','1',1920,1080,1,'en-US','UTC')`,
		id, h.OrgID, uuid.NewString(), name, config.location, config.platform)
	h.exec(`INSERT INTO screen_manifest_state(screen_id) VALUES($1)`, id)
	return id
}

// Location creates a location.
func (h *Harness) Location(name string) uuid.UUID {
	h.t.Helper()
	id := uuid.New()
	h.exec(`INSERT INTO locations(id,organization_id,name) VALUES($1,$2,$3)`, id, h.OrgID, name)
	return id
}

// SyncGroup creates a Display Group containing the screens.
func (h *Harness) SyncGroup(name string, screens ...uuid.UUID) uuid.UUID {
	h.t.Helper()
	id := uuid.New()
	h.exec(`INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,$3,$4)`, id, h.OrgID, name, h.OwnerID)
	for _, screenID := range screens {
		h.exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, id, screenID, h.OwnerID)
	}
	return id
}

// ManifestVersion is the screen's current manifest revision.
func (h *Harness) ManifestVersion(screenID uuid.UUID) int64 {
	h.t.Helper()
	var version int64
	if err := h.Pool.QueryRow(h.Ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screenID).Scan(&version); err != nil {
		h.t.Fatal(err)
	}
	return version
}

// AuditCount counts audit events with an action for a resource.
func (h *Harness) AuditCount(action, resourceID string) int {
	h.t.Helper()
	var count int
	if err := h.Pool.QueryRow(h.Ctx, `SELECT count(*) FROM audit_logs WHERE action=$1 AND resource_id=$2`, action, resourceID).Scan(&count); err != nil {
		h.t.Fatal(err)
	}
	return count
}

// Response is a decoded JSON answer from a plugin route.
type Response struct {
	Status int
	Body   map[string]any
}

// Data is the success envelope's data object.
func (r Response) Data() map[string]any {
	data, _ := r.Body["data"].(map[string]any)
	return data
}

// ErrorCode is the error envelope's code.
func (r Response) ErrorCode() string {
	envelope, _ := r.Body["error"].(map[string]any)
	code, _ := envelope["code"].(string)
	return code
}

// Serve calls one of the plugin's routes as a user with the given role. The
// path is below /api/v1. Role checks follow the route's access level; the
// session and CSRF checks are the router's and are covered by the server's
// own tests.
func (h *Harness) Serve(role, method, path, body string) Response {
	h.t.Helper()
	routes, err := h.service.Routes()
	if err != nil {
		h.t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, route := range routes {
		mux.HandleFunc(route.Method+" "+route.Pattern, func(w http.ResponseWriter, r *http.Request) {
			principal := plugin.Principal{UserID: h.OwnerID, Role: role}
			if route.Access == plugin.AccessManager && !principal.CanManage() {
				plugins.WriteError(w, r, &plugin.APIError{Status: http.StatusForbidden, Code: "insufficient_role",
					Message: "Owner or Administrator access is required."}, nil)
				return
			}
			if err := route.Handler(w, r.WithContext(plugin.WithPrincipal(r.Context(), principal))); err != nil {
				plugins.WriteError(w, r, err, nil)
			}
		})
	}
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	raw, _ := io.ReadAll(recorder.Result().Body)
	decoded := map[string]any{}
	_ = json.Unmarshal(raw, &decoded)
	return Response{Status: recorder.Code, Body: decoded}
}
