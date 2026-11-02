package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

// TestUpdateDeploymentRoutesAreScoped covers the update-deployment routes for a
// scoped operator.
//
// These routes cannot be scoped by requireScreenScope: their {id} is a
// deployment, not a screen, and a deployment names a set of screens. So the
// filter is that set, and it splits by what the route does. A read narrows to
// the caller's screens, because the point of a scope is that an operator sees
// their own hallway. Cancelling stops the deployment everywhere, so it is
// refused unless the caller can reach all of it. A retry installs on one screen
// and follows the single-screen rule.
func TestUpdateDeploymentRoutesAreScoped(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users,locations CASCADE`); err != nil {
		t.Fatal(err)
	}

	organizationID, userID := uuid.New(), uuid.New()
	westWing, eastWing := uuid.New(), uuid.New()
	mine, theirs := uuid.New(), uuid.New()
	releaseID, deployment := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(true,'Scope Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Wing Lead','lead','test','administrator')`, userID); err != nil {
		t.Fatal(err)
	}
	for id, name := range map[uuid.UUID]string{westWing: "West Wing", eastWing: "East Wing"} {
		if _, err = pool.Exec(ctx, `INSERT INTO locations(id,organization_id,name) VALUES($1,$2,$3)`, id, organizationID, name); err != nil {
			t.Fatal(err)
		}
	}
	screen := func(id, location uuid.UUID, name string) {
		if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,location_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone,last_heartbeat_at) VALUES($1,$2,$3,$4,$5,'android-tv','Test','Test','14','0.10.0',1920,1080,1,'en-US','UTC',now())`, id, organizationID, location, uuid.NewString(), name); err != nil {
			t.Fatal(err)
		}
	}
	screen(mine, westWing, "West Lobby")
	screen(theirs, eastWing, "East Lobby")
	if _, err = pool.Exec(ctx, `INSERT INTO player_releases(id,source,channel,version_code,version_name,application_id,minimum_sdk,release_notes,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_signature,cache_status,verification_status,imported_by) VALUES($1,'upload','stable',11,'0.11.0','org.tilecast.player',23,'',now(),'tilecast-player.apk',1024,$2,$3,'{}'::jsonb,'signature','cached','verified',$4)`, releaseID, "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", userID); err != nil {
		t.Fatal(err)
	}
	// One deployment across both wings, with the caller's screen failed so it is
	// retryable.
	if _, err = pool.Exec(ctx, `INSERT INTO update_deployments(id,release_id,name,mode,created_by,status,started_at)VALUES($1,$2,'Fleet update','install_now',$3,'active',now())`, deployment, releaseID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_update_states(deployment_id,screen_id,expected_version_code,state,safe_error)VALUES($1,$2,11,'failed','installer_conflict'),($1,$3,11,'pending',NULL)`, deployment, mine, theirs); err != nil {
		t.Fatal(err)
	}

	deviceService := devices.NewService(pool, devices.NewPresenceHub(), "http://localhost")
	s := &server{
		db:      pool,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		devices: deviceService,
		authz:   authz.New(pool),
	}
	setScreenPolicy(t, pool, userID, userID, authz.PolicyInput{Mode: authz.ModeRestricted, Grants: []authz.Grant{{Type: "location", ID: westWing}}})

	// The list reports the deployment, but the counts are the caller's screens
	// only. Two screens are deployed to; one is theirs.
	recorder := httptest.NewRecorder()
	s.listUpdateDeployments(recorder, deploymentRequest(http.MethodGet, "/api/v1/update-deployments", userID, "administrator"))
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var list struct {
		Data struct {
			Items []struct {
				ID          uuid.UUID `json:"id"`
				TargetCount int       `json:"targetCount"`
			} `json:"items"`
		} `json:"data"`
	}
	if err = json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Data.Items) != 1 || list.Data.Items[0].TargetCount != 1 {
		t.Fatalf("scoped list = %#v, want one deployment counting one screen", list.Data.Items)
	}

	// The detail read lists only the caller's screen.
	detail := s.deploymentDetail(t, userID, deployment)
	if len(detail) != 1 || detail[0] != mine {
		t.Errorf("scoped detail = %v, want only %v", detail, mine)
	}

	// Cancelling would stop the East Wing screen too, so it is refused rather
	// than half-applied.
	cancelled := httptest.NewRecorder()
	s.guard(http.MethodPost, "/api/v1/update-deployments/{id}/cancel", http.HandlerFunc(s.cancelUpdateDeployment)).ServeHTTP(cancelled, routeContext(
		deploymentRequest(http.MethodPost, "/api/v1/update-deployments/"+deployment.String()+"/cancel", userID, "administrator"),
		map[string]string{"id": deployment.String()}))
	if cancelled.Code != http.StatusForbidden {
		t.Errorf("cancel across scopes status=%d body=%s, want 403", cancelled.Code, cancelled.Body.String())
	}
	var status string
	if err = pool.QueryRow(ctx, `SELECT status FROM update_deployments WHERE id=$1`, deployment).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "active" {
		t.Errorf("deployment status=%q, want it untouched by a refused cancel", status)
	}

	// Retrying the caller's own failed screen is allowed; the other wing's is not,
	// and is reported as if the screen did not exist.
	if code := s.retryStatus(t, userID, deployment, mine); code != http.StatusAccepted {
		t.Errorf("retry of an in-scope screen status=%d, want 202", code)
	}
	if code := s.retryStatus(t, userID, deployment, theirs); code != http.StatusNotFound {
		t.Errorf("retry of an out-of-scope screen status=%d, want 404", code)
	}

	// A deployment that reaches nothing in scope is not theirs to read at all.
	if _, err = pool.Exec(ctx, `DELETE FROM screen_update_states WHERE deployment_id=$1 AND screen_id=$2`, deployment, mine); err != nil {
		t.Fatal(err)
	}
	elsewhere := httptest.NewRecorder()
	s.guard(http.MethodGet, "/api/v1/update-deployments/{id}", http.HandlerFunc(s.getUpdateDeployment)).ServeHTTP(elsewhere, routeContext(
		deploymentRequest(http.MethodGet, "/api/v1/update-deployments/"+deployment.String(), userID, "administrator"),
		map[string]string{"id": deployment.String()}))
	if elsewhere.Code != http.StatusNotFound {
		t.Errorf("reading a deployment outside the scope status=%d, want 404", elsewhere.Code)
	}

	// An unscoped account still sees the whole fleet.
	setScreenPolicy(t, pool, userID, userID, authz.PolicyInput{Mode: authz.ModeAll})
	if all := s.deploymentDetail(t, userID, deployment); len(all) != 1 || all[0] != theirs {
		t.Errorf("unscoped detail = %v, want the remaining screen %v", all, theirs)
	}
}

// routeContext attaches chi URL parameters, which the handlers read directly.
func routeContext(request *http.Request, params map[string]string) *http.Request {
	route := chi.NewRouteContext()
	for key, value := range params {
		route.URLParams.Add(key, value)
	}
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
}

// deploymentDetail returns the screen ids the detail route reports.
func (s *server) deploymentDetail(t *testing.T, user, deployment uuid.UUID) []uuid.UUID {
	t.Helper()
	recorder := httptest.NewRecorder()
	s.getUpdateDeployment(recorder, routeContext(
		deploymentRequest(http.MethodGet, "/api/v1/update-deployments/"+deployment.String(), user, "administrator"),
		map[string]string{"id": deployment.String()}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("detail status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Data struct {
			Screens []struct {
				ScreenID uuid.UUID `json:"screenId"`
			} `json:"screens"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	ids := []uuid.UUID{}
	for _, item := range body.Data.Screens {
		ids = append(ids, item.ScreenID)
	}
	return ids
}

func (s *server) retryStatus(t *testing.T, user, deployment, screen uuid.UUID) int {
	t.Helper()
	recorder := httptest.NewRecorder()
	s.guard(http.MethodPost, "/api/v1/update-deployments/{id}/screens/{screenId}/retry", http.HandlerFunc(s.retryUpdateScreen)).ServeHTTP(recorder, routeContext(
		deploymentRequest(http.MethodPost, "/api/v1/update-deployments/"+deployment.String()+"/screens/"+screen.String()+"/retry", user, "administrator"),
		map[string]string{"id": deployment.String(), "screenId": screen.String()}))
	return recorder.Code
}
