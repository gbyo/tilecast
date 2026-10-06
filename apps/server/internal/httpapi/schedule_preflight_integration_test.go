package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/oauth"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/presentations"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

// The preflight reads what a schedule would do, so every role may ask. What it
// may ask about is bounded by the same screen scope a save respects.
func TestSchedulePreflightHTTPBoundary(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := t.Context()
		inScope, outOfScope, scoped := scopedActivityFixture(t, env)
		if _, err := env.pool.Exec(ctx, `UPDATE users SET role='viewer' WHERE id=$1`, scoped.User.ID); err != nil {
			t.Fatal(err)
		}
		authService := auth.NewService(env.pool, time.Hour)
		api := New(Dependencies{DB: env.pool, Auth: authService, Devices: env.server.devices, Playlists: playlists.NewService(env.pool, nil), Scheduling: scheduling.NewService(env.pool, nil, scheduling.Limits{MaxSchedules: 100, MaxTargetsPerSchedule: 100}), Presentations: presentations.NewService(env.pool, nil), Logger: env.server.logger, CookieName: "tilecast_session"})
		token, _, err := oauth.NewService(env.pool).CreatePAT(ctx, scoped.User.ID, "preflight-reader", []string{"read"}, 30)
		if err != nil {
			t.Fatal(err)
		}
		post := func(path, credential, body string) *httptest.ResponseRecorder {
			t.Helper()
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			if credential != "" {
				request.Header.Set("Authorization", "Bearer "+credential)
			}
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			return response
		}
		draft := func(screen uuid.UUID) string {
			return `{"proposedSchedule":{"name":"","description":"","type":"weekly","timezone":"UTC","priority":0,"enabled":true,"dailyStart":"09:00","dailyEnd":"17:00","daysOfWeek":[1,2,3,4,5],"displayAction":{"type":"display_power_on"},"targets":[{"type":"screen","id":"` + screen.String() + `"}]}}`
		}

		ok := post("/api/v1/schedules/preflight", token, draft(inScope))
		if ok.Code != http.StatusOK {
			t.Fatalf("a viewer's in-scope check status=%d body=%s", ok.Code, ok.Body.String())
		}
		var envelope struct {
			Data struct {
				TargetScreenCount int               `json:"targetScreenCount"`
				Competitors       []json.RawMessage `json:"competitors"`
				Screens           []json.RawMessage `json:"screens"`
				Issues            []json.RawMessage `json:"issues"`
			} `json:"data"`
		}
		if err = json.Unmarshal(ok.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Data.TargetScreenCount != 1 || envelope.Data.Competitors == nil || envelope.Data.Screens == nil || envelope.Data.Issues == nil {
			t.Fatalf("lists must be present, never null: %s", ok.Body.String())
		}

		if denied := post("/api/v1/schedules/preflight", token, draft(outOfScope)); denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "out_of_scope") {
			t.Fatalf("an out-of-scope target status=%d body=%s", denied.Code, denied.Body.String())
		}
		if anonymous := post("/api/v1/schedules/preflight", "", draft(inScope)); anonymous.Code != http.StatusUnauthorized {
			t.Fatalf("an anonymous check status=%d", anonymous.Code)
		}
		if unknown := post("/api/v1/schedules/preflight", token, `{"proposedSchedule":{},"surprise":true}`); unknown.Code != http.StatusBadRequest {
			t.Fatalf("an unknown field status=%d body=%s", unknown.Code, unknown.Body.String())
		}
		// The exact-screen preview keeps its stricter rule for the same account.
		if preview := post("/api/v1/schedules/preview", token, `{"screenId":"`+inScope.String()+`"}`); preview.Code != http.StatusForbidden {
			t.Fatalf("a viewer's preview status=%d", preview.Code)
		}
	})
}
