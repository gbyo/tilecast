package server_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/plugins/emergency-alerts/server"
)

// routeRecord pins one route declaration. The host applies session,
// enrollment, role, CSRF, and rate-limit handling generically from this
// metadata, so the declaration is the policy.
type routeRecord struct {
	method    string
	pattern   string
	access    plugin.Access
	rateLimit plugin.RateLimit
}

type recordingRouter struct{ routes []routeRecord }

func (r *recordingRouter) Handle(method, pattern string, access plugin.Access, _ plugin.Handler) {
	r.routes = append(r.routes, routeRecord{method: method, pattern: pattern, access: access})
}

func (r *recordingRouter) HandleWithRateLimit(method, pattern string, access plugin.Access, rateLimit plugin.RateLimit, _ plugin.Handler) {
	r.routes = append(r.routes, routeRecord{method: method, pattern: pattern, access: access, rateLimit: rateLimit})
}

// The poll route must keep its access and operations rate limit through the
// generic plugin route metadata; every other route keeps its previous
// access level. This needs no database: routes are pure declarations.
func TestRouteDeclarations(t *testing.T) {
	recorder := &recordingRouter{}
	server.NewService().Routes(recorder)
	want := map[string]routeRecord{
		"GET /alerts/nws": {
			method: http.MethodGet, pattern: "/alerts/nws", access: plugin.AccessViewer,
		},
		"GET /alerts/nws/zones": {
			method: http.MethodGet, pattern: "/alerts/nws/zones", access: plugin.AccessViewer,
		},
		"PUT /alerts/nws/monitor": {
			method: http.MethodPut, pattern: "/alerts/nws/monitor", access: plugin.AccessManager,
		},
		"POST /alerts/nws/poll": {
			method: http.MethodPost, pattern: "/alerts/nws/poll",
			access: plugin.AccessManager, rateLimit: plugin.RateLimitOperations,
		},
		"POST /alerts/nws/rules": {
			method: http.MethodPost, pattern: "/alerts/nws/rules", access: plugin.AccessManager,
		},
		"PUT /alerts/nws/rules/{id}": {
			method: http.MethodPut, pattern: "/alerts/nws/rules/{id}", access: plugin.AccessManager,
		},
		"DELETE /alerts/nws/rules/{id}": {
			method: http.MethodDelete, pattern: "/alerts/nws/rules/{id}", access: plugin.AccessManager,
		},
	}
	if len(recorder.routes) != len(want) {
		t.Fatalf("routes = %#v, want %d routes", recorder.routes, len(want))
	}
	for _, route := range recorder.routes {
		key := route.method + " " + route.pattern
		expected, ok := want[key]
		if !ok {
			t.Fatalf("unexpected route %s", key)
		}
		if route != expected {
			t.Fatalf("route %s = %#v, want %#v", key, route, expected)
		}
	}
}

// The public paths stay exactly where they were: the plugin answers the
// historical /api/v1/alerts/nws endpoints, never /plugins/....
func TestAlertRoutes(t *testing.T) {
	h, _ := hostedPlugin(t)
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	fake.county.Store([]byte(`{"features":[{"id":"https://api.weather.gov/zones/county/OHC049","properties":{"name":"Franklin","state":"OH"}}]}`))
	fake.forecast.Store([]byte(`{"features":[{"properties":{"id":"OHZ055","name":"Franklin","state":"OH"}}]}`))
	h.Install()
	lobby := h.Screen("Lobby")
	seedMonitor(t, h, true, []string{"OH"}, nil)

	if r := h.Serve("viewer", http.MethodGet, "/alerts/nws", ""); r.Status != http.StatusOK {
		t.Fatalf("viewer settings = %+v", r)
	} else if data := r.Data(); data["monitor"] == nil || data["rules"] == nil || data["activeAlerts"] == nil {
		t.Fatalf("settings envelope = %+v", r)
	}
	if r := h.Serve("viewer", http.MethodGet, "/alerts/nws/zones?area=OH", ""); r.Status != http.StatusOK {
		t.Fatalf("viewer zones = %+v", r)
	} else if items, _ := r.Data()["items"].([]any); len(items) != 2 {
		t.Fatalf("zones items = %+v", r)
	}
	if r := h.Serve("viewer", http.MethodGet, "/alerts/nws/zones?area=O!", ""); r.Status != http.StatusUnprocessableEntity || r.ErrorCode() != "alert_area_invalid" {
		t.Fatalf("invalid area = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, "/alerts/nws/monitor", `{"enabled":true,"areas":["OH"],"zones":[],"pollIntervalSeconds":30}`); r.Status != http.StatusUnprocessableEntity || r.ErrorCode() != "alert_monitor_invalid" {
		t.Fatalf("invalid monitor = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, "/alerts/nws/monitor", `{"enabled":true,"areas":["OH"],"unknown":1}`); r.Status != http.StatusBadRequest || r.ErrorCode() != "invalid_request" {
		t.Fatalf("unknown monitor field = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, "/alerts/nws/monitor", `{"enabled":true,"areas":["OH"],"zones":[],"pollIntervalSeconds":120}`); r.Status != http.StatusOK {
		t.Fatalf("monitor update = %+v", r)
	}
	if r := h.Serve("viewer", http.MethodPut, "/alerts/nws/monitor", `{"enabled":true,"areas":["OH"],"zones":[],"pollIntervalSeconds":120}`); r.Status != http.StatusForbidden {
		t.Fatalf("viewer monitor update = %+v", r)
	}
	if r := h.Serve("viewer", http.MethodPost, "/alerts/nws/poll", ""); r.Status != http.StatusForbidden {
		t.Fatalf("viewer poll = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPost, "/alerts/nws/poll", ""); r.Status != http.StatusOK {
		t.Fatalf("owner poll = %+v", r)
	} else if data := r.Data(); data["monitor"] == nil {
		t.Fatalf("poll envelope = %+v", r)
	}
	fake.fail.Store(true)
	if r := h.Serve("owner", http.MethodPost, "/alerts/nws/poll", ""); r.Status != http.StatusBadGateway || r.ErrorCode() != "nws_poll_failed" {
		t.Fatalf("failing poll = %+v", r)
	}
	fake.fail.Store(false)

	create := `{"name":"Ticker","enabled":true,"eventNames":["Tornado Warning"],` +
		`"minimumSeverity":"Severe","minimumUrgency":"Expected","responseMode":"ticker",` +
		`"tickerDisplayMode":"push","tickerHeightPx":120,"tickerSpeed":"fast",` +
		`"maximumDurationMinutes":360,"screenIds":["` + lobby.String() + `"],"groupIds":[]}`
	if r := h.Serve("viewer", http.MethodPost, "/alerts/nws/rules", create); r.Status != http.StatusForbidden {
		t.Fatalf("viewer rule create = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPost, "/alerts/nws/rules", `{"name":"Ticker","bogus":1}`); r.Status != http.StatusBadRequest || r.ErrorCode() != "invalid_request" {
		t.Fatalf("unknown rule field = %+v", r)
	}
	created := h.Serve("owner", http.MethodPost, "/alerts/nws/rules", create)
	if created.Status != http.StatusCreated {
		t.Fatalf("rule create = %+v", created)
	}
	id, _ := created.Data()["id"].(string)
	if id == "" {
		t.Fatalf("rule create envelope = %+v", created)
	}
	unknownID := uuid.NewString()
	if r := h.Serve("owner", http.MethodPut, "/alerts/nws/rules/"+unknownID, create); r.Status != http.StatusNotFound || r.ErrorCode() != "alert_rule_not_found" {
		t.Fatalf("unknown rule update = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, "/alerts/nws/rules/"+id, `{"name":""}`); r.Status != http.StatusUnprocessableEntity || r.ErrorCode() != "alert_rule_invalid" {
		t.Fatalf("invalid rule update = %+v", r)
	}
	if r := h.Serve("owner", http.MethodDelete, "/alerts/nws/rules/"+unknownID, ""); r.Status != http.StatusNotFound || r.ErrorCode() != "alert_rule_not_found" {
		t.Fatalf("unknown rule delete = %+v", r)
	}
	if r := h.Serve("owner", http.MethodDelete, "/alerts/nws/rules/"+id, ""); r.Status != http.StatusOK || r.Data()["deleted"] != true {
		t.Fatalf("rule delete = %+v", r)
	}
}

// While uninstalled, configuration mutations report plugin_not_installed
// and reads still answer from stored configuration.
func TestAlertRoutesWhileUninstalled(t *testing.T) {
	h, _ := hostedPlugin(t)
	fake := newFakeNWS(t)
	redirectNWS(t, fake)
	seedMonitor(t, h, true, []string{"OH"}, nil)

	if r := h.Serve("viewer", http.MethodGet, "/alerts/nws", ""); r.Status != http.StatusOK {
		t.Fatalf("uninstalled viewer settings = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPost, "/alerts/nws/poll", ""); r.Status != http.StatusConflict || r.ErrorCode() != "plugin_not_installed" {
		t.Fatalf("uninstalled poll = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPut, "/alerts/nws/monitor", `{"enabled":false,"areas":[],"zones":[],"pollIntervalSeconds":120}`); r.Status != http.StatusConflict || r.ErrorCode() != "plugin_not_installed" {
		t.Fatalf("uninstalled monitor update = %+v", r)
	}
	if r := h.Serve("owner", http.MethodPost, "/alerts/nws/rules", `{"name":"x"}`); r.Status != http.StatusConflict || r.ErrorCode() != "plugin_not_installed" {
		t.Fatalf("uninstalled rule create = %+v", r)
	}
	if fake.count() != 0 {
		t.Fatalf("uninstalled routes made %d upstream requests", fake.count())
	}
}
