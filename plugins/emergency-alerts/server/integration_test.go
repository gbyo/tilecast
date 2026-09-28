package server_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	emergencyalerts "github.com/tilecast/tilecast/plugins/emergency-alerts"
	"github.com/tilecast/tilecast/plugins/emergency-alerts/server"
)

// hostedPlugin hosts the real Emergency Alerts plugin on a fresh
// organization and returns the hosted Service. The plugin is initialized
// but not installed; tests install it explicitly where the behavior under
// test needs an installation.
func hostedPlugin(t *testing.T, opts ...pluginharness.Option) (*pluginharness.Harness, *server.Service) {
	t.Helper()
	p := emergencyalerts.New()
	h := pluginharness.New(t, p, opts...)
	plug, ok := p.(*emergencyalerts.Plugin)
	if !ok || plug.Service == nil {
		t.Fatal("hosted plugin does not expose its Service")
	}
	return h, plug.Service
}

// fakeNWS answers NWS alert polls and zone lookups without ever reaching
// api.weather.gov. Payloads are settable per test; every request is counted
// so tests can prove an uninstalled or gated plugin stays silent.
type fakeNWS struct {
	server   *httptest.Server
	requests atomic.Int32
	alerts   atomic.Value // []byte GeoJSON feature collection
	county   atomic.Value // []byte GeoJSON feature collection
	forecast atomic.Value // []byte GeoJSON feature collection
	fail     atomic.Bool  // serve 500 for alert polls
}

func newFakeNWS(t *testing.T) *fakeNWS {
	t.Helper()
	fake := &fakeNWS{}
	fake.alerts.Store([]byte(`{"features":[]}`))
	fake.county.Store([]byte(`{"features":[]}`))
	fake.forecast.Store([]byte(`{"features":[]}`))
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.requests.Add(1)
		if fake.fail.Load() && !strings.HasPrefix(r.URL.Path, "/zones/") {
			http.Error(w, "upstream unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/geo+json")
		body := fake.alerts.Load().([]byte)
		switch r.URL.Path {
		case "/zones/county":
			body = fake.county.Load().([]byte)
		case "/zones/forecast":
			body = fake.forecast.Load().([]byte)
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeNWS) count() int { return int(f.requests.Load()) }

// redirectNWS sends the service's api.weather.gov traffic to the fake. The
// service builds its HTTP client with the default transport, so swapping
// http.DefaultTransport redirects every NWS request the test triggers.
// Tests in this package never run in parallel, and the swap is restored on
// cleanup.
func redirectNWS(t *testing.T, fake *fakeNWS) {
	t.Helper()
	target, err := url.Parse(fake.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	previous := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previous })
	http.DefaultTransport = roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host == "api.weather.gov" {
			clone := req.Clone(req.Context())
			clone.URL.Scheme = target.Scheme
			clone.URL.Host = target.Host
			req = clone
		}
		return previous.RoundTrip(req)
	})
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

// seedMonitor ensures the singleton monitor row exists with the given state.
// The harness truncates organization tables with CASCADE, which also wipes
// the monitor row through its updated_by reference, so tests cannot assume
// the migrated default survived.
func seedMonitor(t *testing.T, h *pluginharness.Harness, enabled bool, areas, zones []string) {
	t.Helper()
	if areas == nil {
		areas = []string{}
	}
	if zones == nil {
		zones = []string{}
	}
	if _, err := h.Pool.Exec(h.Ctx, `INSERT INTO alert_monitor(singleton,enabled,areas,zones,poll_interval_seconds,updated_by)
		VALUES(TRUE,$1,$2,$3,120,$4)
		ON CONFLICT(singleton) DO UPDATE SET enabled=$1,areas=$2,zones=$3,poll_interval_seconds=120,updated_by=$4`,
		enabled, areas, zones, h.OwnerID); err != nil {
		t.Fatal(err)
	}
}

// seedReadyPlaylist creates a ready, non-empty custom playlist the rules
// under test can reference, and returns its ID.
func seedReadyPlaylist(t *testing.T, h *pluginharness.Harness, name string) uuid.UUID {
	t.Helper()
	assetID := uuid.New()
	if _, err := h.Pool.Exec(h.Ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by)
		VALUES($1,$2,'Alert image','image','alert.png','image/png',$3,100,1920,1080,'ready',$4)`,
		assetID, h.OrgID, make([]byte, 32), h.OwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Pool.Exec(h.Ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible)
		VALUES($1,$2,'original','local','originals/alert','image/png',100,$3,1920,1080,TRUE)`,
		uuid.New(), assetID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	playlistID := uuid.New()
	if _, err := h.Pool.Exec(h.Ctx, `INSERT INTO playlists(id,organization_id,name,created_by) VALUES($1,$2,$3,$4)`,
		playlistID, h.OrgID, name, h.OwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Pool.Exec(h.Ctx, `INSERT INTO playlist_items(id,playlist_id,asset_id,position,duration_ms) VALUES($1,$2,$3,0,10000)`,
		uuid.New(), playlistID, assetID); err != nil {
		t.Fatal(err)
	}
	return playlistID
}

func queryInt(t *testing.T, h *pluginharness.Harness, query string, args ...any) int {
	t.Helper()
	var count int
	if err := h.Pool.QueryRow(h.Ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func queryString(t *testing.T, h *pluginharness.Harness, query string, args ...any) string {
	t.Helper()
	var value string
	if err := h.Pool.QueryRow(h.Ctx, query, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
