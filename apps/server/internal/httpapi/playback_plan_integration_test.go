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
	"github.com/tilecast/tilecast/apps/server/internal/playbackplan"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/presentations"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

func TestPlaybackPlanHTTPBoundary(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := t.Context()
		exec := func(sql string, args ...any) {
			t.Helper()
			if _, err := env.pool.Exec(ctx, sql, args...); err != nil {
				t.Fatal(err)
			}
		}
		inScope, outOfScope, scoped := scopedActivityFixture(t, env)
		exec(`UPDATE users SET role='viewer' WHERE id=$1`, scoped.User.ID)
		var org uuid.UUID
		if err := env.pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
			t.Fatal(err)
		}
		fallback, scheduled, scheduleID := uuid.New(), uuid.New(), uuid.New()
		for _, id := range []uuid.UUID{fallback, scheduled} {
			exec(`INSERT INTO playlists(id,organization_id,name,revision) VALUES($1,$2,'Plan content',4)`, id, org)
		}
		exec(`INSERT INTO screen_manifest_state(screen_id,manifest_version) VALUES($1,7)`, inScope)
		exec(`INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id) VALUES($1,$2,$3)`, uuid.New(), inScope, fallback)
		exec(`INSERT INTO screen_player_status(screen_id,active_manifest_version,pending_manifest_version) VALUES($1,6,7)`, inScope)
		future := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Second)
		exec(`INSERT INTO schedules(id,organization_id,name,playlist_id,type,timezone,one_time_start,one_time_end) VALUES($1,$2,'Plan schedule',$3,'one_time','UTC',$4,$5)`, scheduleID, org, scheduled, future, future.Add(time.Hour))
		exec(`INSERT INTO schedule_targets(schedule_id,target_type,screen_id) VALUES($1,'screen',$2)`, scheduleID, inScope)
		past := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second)
		window := uuid.New()
		exec(`INSERT INTO expected_playback_windows(id,screen_id,presentation_type,presentation_id,presentation_revision,trigger_source,expected_start,expected_end) VALUES($1,$2,'layout','removed-layout','3','schedule',$3,$4)`, window, inScope, past, past.Add(time.Hour))
		authService := auth.NewService(env.pool, time.Hour)
		passwordHash, err := auth.HashPassword("correct horse battery staple")
		if err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE users SET password_hash=$2 WHERE id=$1`, env.owner.User.ID, passwordHash)
		login, err := authService.Login(ctx, auth.LoginInput{Username: env.owner.User.Username, Password: "correct horse battery staple"}, auth.MFAPolicyNone)
		if err != nil || login.Session == nil {
			t.Fatalf("session login failed: %v", err)
		}
		api := New(Dependencies{DB: env.pool, Auth: authService, Devices: env.server.devices, Playlists: playlists.NewService(env.pool, nil), Scheduling: scheduling.NewService(env.pool, nil, scheduling.Limits{}), Presentations: presentations.NewService(env.pool, nil), Logger: env.server.logger, CookieName: "tilecast_session"})
		grants := oauth.NewService(env.pool)
		token, _, err := grants.CreatePAT(ctx, scoped.User.ID, "plan-reader", []string{"read"}, 30)
		if err != nil {
			t.Fatal(err)
		}
		ownerToken, _, err := grants.CreatePAT(ctx, env.owner.User.ID, "plan-owner", []string{"read"}, 30)
		if err != nil {
			t.Fatal(err)
		}
		get := func(credential, id, query string) *httptest.ResponseRecorder {
			t.Helper()
			request := httptest.NewRequest(http.MethodGet, "/api/v1/screens/"+id+"/playback-plan"+query, nil)
			if credential == "session" {
				request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: login.Session.Token})
			} else if credential != "" {
				request.Header.Set("Authorization", "Bearer "+credential)
			}
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			return response
		}
		read := func(response *httptest.ResponseRecorder) playbackplan.Response {
			t.Helper()
			if response.Code != http.StatusOK {
				t.Fatalf("inspection status=%d body=%s", response.Code, response.Body.String())
			}
			var envelope struct {
				Data playbackplan.Response `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			return envelope.Data
		}
		current := read(get(token, inScope.String(), ""))
		if current.Basis != playbackplan.BasisCurrent || current.Historical != nil || !current.At.Equal(current.EvaluatedAt) || current.Current.Selected.ContentID != fallback || current.Current.Synchronization.Status != "preparing" || current.Current.Capabilities.Status != "not_applicable" || !current.Current.NextEvaluationAt.Equal(future) {
			t.Fatalf("current=%#v evidence=%#v", current, current.Current)
		}
		prediction := read(get(token, inScope.String(), "?at="+future.Format(time.RFC3339)))
		fromCookie := read(get("session", inScope.String(), ""))
		if fromCookie.Current.Selected.ContentID != fallback || fromCookie.Basis != playbackplan.BasisCurrent {
			t.Fatal("session and bearer inspection disagree on selection")
		}
		if prediction.Current.Selected.ContentID != scheduled || prediction.Current.Selected.Source != "schedule" {
			t.Fatalf("prediction=%#v", prediction.Current)
		}
		foundSchedule := false
		for _, candidate := range prediction.Current.Candidates {
			if candidate.ID != nil && *candidate.ID == scheduleID {
				foundSchedule = candidate.Schedule != nil && candidate.Schedule.Specificity == 1 && candidate.Schedule.Priority == 0 && candidate.Status == "selected" && candidate.Schedule.Start.Equal(future)
			}
		}
		if !foundSchedule {
			t.Fatal("schedule reasoning did not reach the public DTO")
		}
		historicalResponse := get(token, inScope.String(), "?at="+past.Format(time.RFC3339))
		history := read(historicalResponse)
		if history.Current != nil || history.Basis != playbackplan.BasisRecorded || history.Historical.Expectation.PresentationID != "removed-layout" || history.Historical.Expectation.WindowID != window {
			t.Fatalf("history=%#v", history)
		}
		for _, forbidden := range []string{fallback.String(), "capabilities", "synchronization", "Plan content", "scheduleExplanation"} {
			if strings.Contains(historicalResponse.Body.String(), forbidden) {
				t.Fatalf("historical response includes current or internal evidence: %s", forbidden)
			}
		}
		gap := read(get(token, inScope.String(), "?at="+past.Add(time.Hour).Format(time.RFC3339)))
		if gap.Basis != playbackplan.BasisUnavailable || gap.Current != nil || gap.Historical.Expectation != nil {
			t.Fatalf("gap used current configuration: %#v", gap)
		}
		for _, query := range []string{"", "?at=" + past.Format(time.RFC3339)} {
			if response := get(token, outOfScope.String(), query); response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "screen_not_found") {
				t.Fatalf("scope status=%d", response.Code)
			}
		}
		for _, test := range []struct {
			credential, id, query string
			status                int
			code                  string
		}{
			{"", inScope.String(), "", 401, "authentication_required"},
			{"tc_device_test.invalid", inScope.String(), "", 401, ""},
			{token, "invalid", "", 404, "not_found"},
			{ownerToken, uuid.NewString(), "", 404, "screen_not_found"},
			{token, inScope.String(), "?at=", 400, "invalid_playback_plan_instant"},
			{token, inScope.String(), "?at=2026-10-02", 400, "invalid_playback_plan_instant"},
			{token, inScope.String(), "?at=" + future.Format(time.RFC3339) + "&at=" + future.Format(time.RFC3339), 400, "invalid_playback_plan_instant"},
		} {
			response := get(test.credential, test.id, test.query)
			if response.Code != test.status || (test.code != "" && !strings.Contains(response.Body.String(), test.code)) {
				t.Fatalf("query %s status=%d body=%s want=%d/%s", test.query, response.Code, response.Body.String(), test.status, test.code)
			}
		}
		// Inspection must not create state for an unenrolled Screen.
		if response := get(ownerToken, outOfScope.String(), ""); response.Code != http.StatusNotFound {
			t.Fatalf("missing manifest state status=%d", response.Code)
		}
		var count, version int64
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM screen_manifest_state WHERE screen_id=$1`, outOfScope).Scan(&count); err != nil || count != 0 {
			t.Fatalf("inspection created manifest state: count=%d err=%v", count, err)
		}
		if err := env.pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, inScope).Scan(&version); err != nil || version != 7 {
			t.Fatalf("inspection changed manifest version=%d err=%v", version, err)
		}
		// Two authoritative windows are a conflict, never a guessed winner.
		exec(`INSERT INTO expected_playback_windows(id,screen_id,presentation_type,presentation_id,presentation_revision,trigger_source,expected_start,expected_end) VALUES($1,$2,'playlist','another-recorded','1','assignment',$3,$4)`, uuid.New(), inScope, past, past.Add(time.Hour))
		if response := get(token, inScope.String(), "?at="+past.Format(time.RFC3339)); response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "playback_expectation_ambiguous") {
			t.Fatalf("ambiguous expectation status=%d body=%s", response.Code, response.Body.String())
		}
	})
}
