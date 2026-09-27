package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

// screens.last_known_ip is INET. Casting an inet to text appends the netmask,
// so the fleet list used to serve "192.0.2.10/32": the screen detail pane
// printed the mask, and the Fire TV panel — which brackets an address only when
// it contains a colon — built the unusable "adb connect 192.0.2.10/32:5555".
// host() renders the bare address, which is what every consumer of this field
// expects. This exercises both screenSelect entry points the dashboard calls.
func TestScreenListAndDetailRenderLastKnownIPWithoutNetmask(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		stored  string
		address string
	}{
		{name: "ipv4", stored: "192.0.2.10", address: "192.0.2.10"},
		{name: "ipv6", stored: "2001:db8::4", address: "2001:db8::4"},
		// A heartbeat that reported a prefix rather than a host address must
		// still resolve to something the ADB and RTP consumers can dial.
		{name: "ipv4 with explicit prefix", stored: "192.0.2.10/24", address: "192.0.2.10"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			withActivityDatabase(t, func(env activityTestEnvironment) {
				if _, err := env.pool.Exec(context.Background(),
					`UPDATE screens SET last_known_ip=$2::inet WHERE id=$1`, env.screenID, testCase.stored); err != nil {
					t.Fatal(err)
				}

				listRequest := httptest.NewRequest(http.MethodGet, "/api/v1/screens", nil)
				listRequest = requestWithTestPrincipal(listRequest, env.owner)
				listResponse := httptest.NewRecorder()
				env.server.listScreens(listResponse, listRequest)
				if listResponse.Code != http.StatusOK {
					t.Fatalf("list status=%d body=%s", listResponse.Code, listResponse.Body.String())
				}
				if strings.Contains(listResponse.Body.String(), testCase.address+"/") {
					t.Fatalf("list response still carries a netmask: %s", listResponse.Body.String())
				}
				var listEnvelope struct {
					Data struct {
						Items []devices.Screen `json:"items"`
					} `json:"data"`
				}
				if err := json.Unmarshal(listResponse.Body.Bytes(), &listEnvelope); err != nil {
					t.Fatal(err)
				}
				if len(listEnvelope.Data.Items) != 1 {
					t.Fatalf("list returned %d screens, want 1: %s", len(listEnvelope.Data.Items), listResponse.Body.String())
				}
				if listed := listEnvelope.Data.Items[0].LastKnownIP; listed == nil || *listed != testCase.address {
					t.Fatalf("list lastKnownIp=%v, want %q", listed, testCase.address)
				}

				detailRequest := httptest.NewRequest(http.MethodGet, "/api/v1/screens/"+env.screenID.String(), nil)
				routeContext := chi.NewRouteContext()
				routeContext.URLParams.Add("id", env.screenID.String())
				detailRequest = detailRequest.WithContext(context.WithValue(
					auth.WithPrincipal(
						context.WithValue(detailRequest.Context(), sessionContextKey, env.owner),
						auth.PrincipalFromSession(env.owner),
					),
					chi.RouteCtxKey, routeContext))
				detailResponse := httptest.NewRecorder()
				env.server.getScreen(detailResponse, detailRequest)
				if detailResponse.Code != http.StatusOK {
					t.Fatalf("detail status=%d body=%s", detailResponse.Code, detailResponse.Body.String())
				}
				var detailEnvelope struct {
					Data devices.Screen `json:"data"`
				}
				if err := json.Unmarshal(detailResponse.Body.Bytes(), &detailEnvelope); err != nil {
					t.Fatal(err)
				}
				if detailed := detailEnvelope.Data.LastKnownIP; detailed == nil || *detailed != testCase.address {
					t.Fatalf("detail lastKnownIp=%v, want %q", detailed, testCase.address)
				}
			})
		})
	}
}

// A screen that has never reported a heartbeat has a NULL last_known_ip, and
// host(NULL) is NULL — the field must stay absent rather than becoming "".
// The Fire TV panel relies on that to fall back to its FIRE_TV_IP placeholder.
func TestScreenWithoutHeartbeatOmitsLastKnownIP(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/screens", nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.listScreens(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("list status=%d body=%s", response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "lastKnownIp") {
			t.Fatalf("unreported address should be omitted: %s", response.Body.String())
		}
		var envelope struct {
			Data struct {
				Items []devices.Screen `json:"items"`
			} `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if len(envelope.Data.Items) != 1 {
			t.Fatalf("list returned %d screens, want 1", len(envelope.Data.Items))
		}
		if envelope.Data.Items[0].LastKnownIP != nil {
			t.Fatalf("lastKnownIp=%q, want nil", *envelope.Data.Items[0].LastKnownIP)
		}
	})
}
