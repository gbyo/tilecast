package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// scopedActivityFixture adds a second operational screen beside the
// environment's screen and a scoped editor whose location grant covers only
// the first screen, plus a failed playback session on the out-of-scope one.
func scopedActivityFixture(t *testing.T, env activityTestEnvironment) (inScope, outOfScope uuid.UUID, scoped auth.Session) {
	t.Helper()
	ctx := context.Background()
	inScope = env.screenID
	outOfScope = uuid.New()
	var org uuid.UUID
	if err := env.pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Lobby Kiosk','android-tv','Test','TV','14','1.0',1920,1080,1,'en-US','America/New_York')`, outOfScope, org, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash) VALUES($1,$2,$3,'\x00'::bytea)`, uuid.New(), outOfScope, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	locationID := uuid.New()
	if _, err := env.pool.Exec(ctx, `INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Main Building')`, locationID, org); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `UPDATE screens SET location_id=$1 WHERE id=$2`, locationID, inScope); err != nil {
		t.Fatal(err)
	}
	scopedID := uuid.New()
	if _, err := env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Scoped Editor','scoped-editor','unused-test-hash','editor',TRUE)`, scopedID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO user_screen_scopes(user_id,scope_type,scope_id) VALUES($1,'location',$2)`, scopedID, locationID); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second)
	if _, err := env.pool.Exec(ctx, `
		INSERT INTO playback_sessions(id,screen_id,activity_session_id,started_at,ended_at,actual_duration_ms,result,session_type,terminal_reason)
		VALUES($1,$2,$3,$4,$5,$6,'failed','presentation','renderer_failure')`,
		uuid.New(), outOfScope, "out-of-scope-failure", start, start.Add(time.Minute), (time.Minute).Milliseconds()); err != nil {
		t.Fatal(err)
	}
	scoped = auth.Session{User: auth.User{ID: scopedID, Name: "Scoped Editor", Username: "scoped-editor", Role: "editor", Active: true}}
	return inScope, outOfScope, scoped
}

func TestActivityOverviewRespectsScreenScope(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		_, _, scoped := scopedActivityFixture(t, env)

		overview := func(session auth.Session) activityOverviewData {
			t.Helper()
			request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/overview?range=24h", nil)
			request = requestWithTestPrincipal(request, session)
			response := httptest.NewRecorder()
			env.server.activityOverview(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("overview status=%d body=%s", response.Code, response.Body.String())
			}
			var envelope struct {
				Data activityOverviewData `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			return envelope.Data
		}

		owner := overview(env.owner)
		if owner.Fleet.Measured != 2 {
			t.Fatalf("owner fleet measured=%d, want both screens", owner.Fleet.Measured)
		}
		if owner.Cards.PlaybackFailures != 1 {
			t.Fatalf("owner playback failures=%d, want the out-of-scope failure", owner.Cards.PlaybackFailures)
		}
		narrowed := overview(scoped)
		if narrowed.Fleet.Measured != 1 {
			t.Fatalf("scoped fleet measured=%d, want only the in-scope screen", narrowed.Fleet.Measured)
		}
		if narrowed.Cards.PlaybackFailures != 0 {
			t.Fatalf("scoped playback failures=%d, want the out-of-scope failure excluded", narrowed.Cards.PlaybackFailures)
		}
	})
}

func TestScreenActivityRequiresScope(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		inScope, outOfScope, scoped := scopedActivityFixture(t, env)

		get := func(session auth.Session, id uuid.UUID) *httptest.ResponseRecorder {
			t.Helper()
			request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/screens/"+id.String(), nil)
			request = requestWithTestPrincipal(request, session)
			response := httptest.NewRecorder()
			env.server.screenActivity(response, request)
			return response
		}

		if response := get(scoped, outOfScope); response.Code != http.StatusNotFound {
			t.Fatalf("out-of-scope screen status=%d body=%s, want 404", response.Code, response.Body.String())
		} else if body := response.Body.String(); !strings.Contains(body, "screen_not_found") {
			t.Fatalf("out-of-scope screen body=%s, want screen_not_found", body)
		}
		if response := get(scoped, inScope); response.Code != http.StatusOK {
			t.Fatalf("in-scope screen status=%d body=%s, want 200", response.Code, response.Body.String())
		}
		if response := get(env.owner, outOfScope); response.Code != http.StatusOK {
			t.Fatalf("owner out-of-scope screen status=%d body=%s, want 200", response.Code, response.Body.String())
		}
	})
}

func TestScreenTimelineRequiresScope(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		inScope, outOfScope, scoped := scopedActivityFixture(t, env)

		get := func(session auth.Session, id uuid.UUID) *httptest.ResponseRecorder {
			t.Helper()
			request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/screens/"+id.String()+"/timeline?range=24h", nil)
			request = requestWithTestPrincipal(request, session)
			response := httptest.NewRecorder()
			env.server.screenTimeline(response, request)
			return response
		}

		if response := get(scoped, outOfScope); response.Code != http.StatusNotFound {
			t.Fatalf("out-of-scope timeline status=%d body=%s, want 404", response.Code, response.Body.String())
		}
		if response := get(scoped, inScope); response.Code != http.StatusOK {
			t.Fatalf("in-scope timeline status=%d body=%s, want 200", response.Code, response.Body.String())
		}
	})
}
