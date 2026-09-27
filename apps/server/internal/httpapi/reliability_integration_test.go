package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The reliability payload is assembled by jsonb_build_object, and Postgres
// rejects any function call with more than 100 arguments. Adding fields to that
// payload is a run-time failure, not a compile-time one, so this exercises the
// real query against the real schema: AirPlay's 21 columns once pushed it past
// the limit and every reliability request returned 500.
func TestScreenReliabilityBuildsFullPayload(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		if _, err := env.pool.Exec(context.Background(), `INSERT INTO screen_player_status(screen_id,airplay_supported,airplay_max_profile,airplay_group_supported,airplay_hardware_decode) VALUES($1,TRUE,'1080p30',TRUE,TRUE)`, env.screenID); err != nil {
			t.Fatal(err)
		}

		routeContext := chi.NewRouteContext()
		routeContext.URLParams.Add("id", env.screenID.String())
		request := httptest.NewRequest(http.MethodGet, "/screens/"+env.screenID.String()+"/reliability", nil)
		request = requestWithTestPrincipal(request, env.owner)
		request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
		recorder := httptest.NewRecorder()

		env.server.screenReliability(recorder, request)

		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
		var payload struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"configuredMode", "autostartState", "airplaySupported", "airplayMaxProfile", "externalPresentationState", "powerAssist"} {
			if _, ok := payload.Data[field]; !ok {
				t.Fatalf("reliability payload is missing %q: %v", field, payload.Data)
			}
		}
		if payload.Data["airplaySupported"] != true {
			t.Fatalf("airplaySupported = %v", payload.Data["airplaySupported"])
		}
		if payload.Data["airplayMaxProfile"] != "1080p30" {
			t.Fatalf("airplayMaxProfile = %v", payload.Data["airplayMaxProfile"])
		}
	})
}
