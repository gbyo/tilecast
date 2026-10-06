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
		// A scoped account sees a competing schedule only when all of its targets
		// are inside the scope; otherwise the name and ID are withheld.
		var org uuid.UUID
		if err = env.pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(ctx, `UPDATE screens SET platform='linux' WHERE id=$1`, inScope); err != nil {
			t.Fatal(err)
		}
		playlist, secret, shared := uuid.New(), uuid.New(), uuid.New()
		if _, err = env.pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name) VALUES($1,$2,'Rival content')`, playlist, org); err != nil {
			t.Fatal(err)
		}
		for _, rival := range []struct {
			id       uuid.UUID
			name     string
			priority int
			outside  bool
		}{{secret, "Secret rival", 800, true}, {shared, "Visible rival", 700, false}} {
			if _, err = env.pool.Exec(ctx, `INSERT INTO schedules(id,organization_id,name,playlist_id,type,timezone,priority,daily_start,daily_end,days_of_week) VALUES($1,$2,$3,$4,'weekly','UTC',$5,'00:00','23:59','{0,1,2,3,4,5,6}')`, rival.id, org, rival.name, playlist, rival.priority); err != nil {
				t.Fatal(err)
			}
			if _, err = env.pool.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_id) VALUES($1,'screen',$2)`, rival.id, inScope); err != nil {
				t.Fatal(err)
			}
			if rival.outside {
				if _, err = env.pool.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_id) VALUES($1,'screen',$2)`, rival.id, outOfScope); err != nil {
					t.Fatal(err)
				}
			}
		}
		rivals := post("/api/v1/schedules/preflight", token, draft(inScope))
		if rivals.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rivals.Code, rivals.Body.String())
		}
		var seen struct {
			Data struct {
				Competitors []struct {
					ScheduleID          uuid.UUID `json:"scheduleId"`
					Name                string    `json:"name"`
					AffectedScreenCount int       `json:"affectedScreenCount"`
				} `json:"competitors"`
				Screens []struct {
					WinnerScheduleID *uuid.UUID `json:"winnerScheduleId"`
					WinnerName       string     `json:"winnerName"`
				} `json:"screens"`
			} `json:"data"`
		}
		if err = json.Unmarshal(rivals.Body.Bytes(), &seen); err != nil {
			t.Fatal(err)
		}
		names := map[string]uuid.UUID{}
		for _, c := range seen.Data.Competitors {
			if c.AffectedScreenCount != 1 {
				t.Fatalf("counts must survive redaction: %+v", c)
			}
			names[c.Name] = c.ScheduleID
		}
		if _, ok := names["Visible rival"]; !ok || len(names) != 2 {
			t.Fatalf("competitors=%+v", seen.Data.Competitors)
		}
		if hidden, ok := names[""]; !ok || hidden == secret {
			t.Fatalf("the hidden competitor kept its name or ID: %+v", seen.Data.Competitors)
		}
		if strings.Contains(rivals.Body.String(), "Secret rival") || strings.Contains(rivals.Body.String(), secret.String()) {
			t.Fatalf("a hidden schedule leaked: %s", rivals.Body.String())
		}
		// Winners are redacted the same way; the top-priority rival wins here.
		if len(seen.Data.Screens) != 1 || seen.Data.Screens[0].WinnerName != "" || seen.Data.Screens[0].WinnerScheduleID == nil || *seen.Data.Screens[0].WinnerScheduleID == secret {
			t.Fatalf("screens=%+v", seen.Data.Screens)
		}
		// The exact-screen preview keeps its stricter rule for the same account.
		if preview := post("/api/v1/schedules/preview", token, `{"screenId":"`+inScope.String()+`"}`); preview.Code != http.StatusForbidden {
			t.Fatalf("a viewer's preview status=%d", preview.Code)
		}
	})
}
