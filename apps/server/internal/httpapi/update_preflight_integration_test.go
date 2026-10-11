package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

func (f *edgeFixture) preview(t *testing.T, input updateSelection, role string) (updatePreview, int) {
	t.Helper()
	body, _ := json.Marshal(input)
	request := requestWithTestPrincipal(httptest.NewRequest(http.MethodPost, "/api/v1/update-deployments/preview", bytes.NewReader(body)), auth.Session{User: auth.User{ID: f.user, Role: role}})
	response := httptest.NewRecorder()
	f.server.previewUpdateDeployment(response, request)
	var envelope struct{ Data updatePreview }
	if response.Code == 200 {
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
	}
	return envelope.Data, response.Code
}

func TestUpdatePreviewAndroidSDKAndCurrentRules(t *testing.T) {
	f := newEdgeFixture(t)
	release := f.edgeRelease(t, "x86_64")
	if _, err := f.pool.Exec(f.ctx, `UPDATE player_releases SET platform='android',player_family='android',architecture='',application_id='org.tilecast.player',apk_name='tilecast-player.apk',minimum_sdk=30,state_schema_version=NULL WHERE id=$1`, release); err != nil {
		t.Fatal(err)
	}
	low := f.screen(t, "Older TV", "android-tv", "", "", 1000)
	unknown := f.screen(t, "Unknown SDK", "android-tv", "", "", 1000)
	current := f.screen(t, "Updated TV", "android-tv", "", "", 2000)
	if _, err := f.pool.Exec(f.ctx, `UPDATE screen_player_status SET android_sdk=29 WHERE screen_id=ANY($1)`, []uuid.UUID{low, current}); err != nil {
		t.Fatal(err)
	}
	result, status := f.preview(t, updateSelection{ReleaseID: release, ScreenIDs: []uuid.UUID{low, unknown, current}}, "owner")
	if status != 200 || result.BlockedCount != 1 || result.EligibleCount != 1 || result.AlreadyCurrentCount != 1 {
		t.Fatalf("SDK preview: %d %#v", status, result)
	}
	deployment, count := f.deploy(t, release, low, unknown, current)
	if count != 3 || f.state(t, deployment, low) != "incompatible" || f.state(t, deployment, unknown) != "pending" || f.state(t, deployment, current) != "already_current" {
		t.Fatal("SDK/current preview and creation disagree")
	}
	var reason string
	if err := f.pool.QueryRow(f.ctx, `SELECT safe_error FROM screen_update_states WHERE deployment_id=$1 AND screen_id=$2`, deployment, low).Scan(&reason); err != nil || !strings.Contains(reason, "SDK 29") {
		t.Fatalf("SDK reason: %s %v", reason, err)
	}
}

func TestPausedUpdateCanBeCancelledAndProtectsCache(t *testing.T) {
	f := newEdgeFixture(t)
	release := f.edgeRelease(t, "x86_64")
	screen := f.screen(t, "Lobby", "linux", "edge", "x86_64", 1000)
	deployment, _ := f.deploy(t, release, screen)
	if _, err := f.pool.Exec(f.ctx, `UPDATE update_deployments SET status='paused',rollout_phase='paused' WHERE id=$1`, deployment); err != nil {
		t.Fatal(err)
	}
	request := requestWithTestPrincipal(httptest.NewRequest(http.MethodDelete, "/api/v1/player-releases/"+release.String(), nil), auth.Session{User: auth.User{ID: f.user, Role: "owner"}})
	router := chi.NewRouter()
	router.Delete("/api/v1/player-releases/{id}", f.server.deletePlayerRelease)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("paused cache protection: %d %s", response.Code, response.Body)
	}
	request = requestWithTestPrincipal(httptest.NewRequest(http.MethodPost, "/api/v1/update-deployments/"+deployment.String()+"/cancel", nil), auth.Session{User: auth.User{ID: f.user, Role: "owner"}})
	router.Post("/api/v1/update-deployments/{id}/cancel", f.server.cancelUpdateDeployment)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || f.state(t, deployment, screen) != "cancelled" {
		t.Fatalf("paused cancellation: %d %s", response.Code, response.Body)
	}
	var commands int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM player_commands WHERE payload->>'deploymentId'=$1 AND state='cancelled'`, deployment.String()).Scan(&commands); err != nil || commands != 1 {
		t.Fatalf("commands not cancelled: %d %v", commands, err)
	}
}

func TestUpdatePreviewMatchesCreationWithoutWrites(t *testing.T) {
	f := newEdgeFixture(t)
	release := f.edgeRelease(t, "x86_64")
	eligible := f.screen(t, "Lobby", "linux", "edge", "x86_64", 1000)
	offline := f.screen(t, "Offline", "linux", "edge", "x86_64", 1000)
	mismatch := f.screen(t, "ARM", "linux", "edge", "aarch64", 1000)
	unknown := f.screen(t, "Unknown", "linux", "edge", "", 1000)
	current := f.screen(t, "Current", "linux", "edge", "x86_64", 2000)
	other := f.screen(t, "Electron", "linux", "", "", 1000)
	if _, err := f.pool.Exec(f.ctx, `UPDATE screens SET last_heartbeat_at=now()-interval '16 minutes' WHERE id=$1`, offline); err != nil {
		t.Fatal(err)
	}
	group := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO screen_groups(id,organization_id,name) VALUES($1,$2,'Building')`, group, f.org); err != nil {
		t.Fatal(err)
	}
	for _, id := range []uuid.UUID{eligible, offline, mismatch, unknown, current, other} {
		if _, err := f.pool.Exec(f.ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id) VALUES($1,$2)`, group, id); err != nil {
			t.Fatal(err)
		}
	}
	input := updateSelection{ReleaseID: release, ScreenIDs: []uuid.UUID{eligible, eligible}, GroupIDs: []uuid.UUID{group, group}}
	preview, status := f.preview(t, input, "owner")
	if status != 200 || preview.TargetCount != 6 || preview.EligibleCount != 2 || preview.OfflineCount != 1 || preview.AlreadyCurrentCount != 1 || preview.BlockedCount != 3 {
		t.Fatalf("preview status=%d %#v", status, preview)
	}
	for _, table := range []string{"update_deployments", "update_deployment_targets", "screen_update_states", "player_commands", "audit_logs"} {
		var count int
		if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("preview wrote %s count=%d err=%v", table, count, err)
		}
	}
	body, _ := json.Marshal(deploymentInput{ReleaseID: release, Name: "Rollout", Mode: "install_now", ScreenIDs: input.ScreenIDs, GroupIDs: input.GroupIDs})
	request := requestWithTestPrincipal(httptest.NewRequest(http.MethodPost, "/api/v1/update-deployments", bytes.NewReader(body)), auth.Session{User: auth.User{ID: f.user, Role: "owner"}})
	response := httptest.NewRecorder()
	f.server.createUpdateDeployment(response, request)
	if response.Code != 201 {
		t.Fatalf("create: %d %s", response.Code, response.Body)
	}
	var created struct {
		Data struct {
			ID          uuid.UUID
			TargetCount int
		}
	}
	_ = json.Unmarshal(response.Body.Bytes(), &created)
	if created.Data.TargetCount != 5 {
		t.Fatalf("creation must exclude other family, count=%d", created.Data.TargetCount)
	}
	for _, target := range preview.Screens {
		if target.Family != "edge" {
			if got := f.state(t, created.Data.ID, target.ID); got != "not_targeted" {
				t.Fatalf("other family targeted: %s", got)
			}
			continue
		}
		expected := map[string]string{"eligible": "pending", "offline": "offline", "incompatible": "incompatible", "already_current": "already_current"}[target.Outcome]
		if got := f.state(t, created.Data.ID, target.ID); got != expected {
			t.Fatalf("preview/create disagree for %s: %s want %s", target.Name, got, expected)
		}
		var reason *string
		_ = f.pool.QueryRow(f.ctx, `SELECT safe_error FROM screen_update_states WHERE deployment_id=$1 AND screen_id=$2`, created.Data.ID, target.ID).Scan(&reason)
		if target.Reason != nil && (reason == nil || *reason != *target.Reason) {
			t.Fatalf("lost precise reason for %s", target.Name)
		}
	}
	var commands int
	_ = f.pool.QueryRow(f.ctx, `SELECT count(*) FROM player_commands WHERE type='install_player_update'`).Scan(&commands)
	if commands != 2 {
		t.Fatalf("online and offline eligible screens get commands, got %d", commands)
	}
}

func TestUpdatePreviewIsAdvisoryAndScopeBound(t *testing.T) {
	f := newEdgeFixture(t)
	release := f.edgeRelease(t, "x86_64")
	screen := f.screen(t, "Lobby", "linux", "edge", "x86_64", 1000)
	input := updateSelection{ReleaseID: release, ScreenIDs: []uuid.UUID{screen}}
	result, status := f.preview(t, input, "owner")
	if status != 200 || result.BlockedCount != 0 {
		t.Fatal("initial preview must be eligible")
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE screen_player_status SET player_architecture='aarch64' WHERE screen_id=$1`, screen); err != nil {
		t.Fatal(err)
	}
	deployment, _ := f.deploy(t, release, screen)
	if got := f.state(t, deployment, screen); got != "incompatible" {
		t.Fatalf("creation reused stale preview: %s", got)
	}
	var reason string
	_ = f.pool.QueryRow(f.ctx, `SELECT safe_error FROM screen_update_states WHERE deployment_id=$1 AND screen_id=$2`, deployment, screen).Scan(&reason)
	if !strings.Contains(reason, "aarch64") {
		t.Fatalf("wrong reason: %s", reason)
	}
	other := f.screen(t, "Out of scope", "linux", "edge", "x86_64", 1000)
	location := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO locations(id,organization_id,name)VALUES($1,$2,'Scoped location')`, location, f.org); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE screens SET location_id=$1 WHERE id=$2`, location, screen); err != nil {
		t.Fatal(err)
	}
	if err := f.server.devices.ReplaceScopes(f.ctx, f.user, f.user, []devices.Scope{{Type: "location", ID: location}}); err != nil {
		t.Fatal(err)
	}
	if _, status := f.preview(t, updateSelection{ReleaseID: release, ScreenIDs: []uuid.UUID{other}}, "administrator"); status != 403 {
		t.Fatalf("scope leaked: %d", status)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE player_releases SET cache_status='missing' WHERE id=$1`, release); err != nil {
		t.Fatal(err)
	}
	if id, _ := f.deploy(t, release, screen); id != uuid.Nil {
		t.Fatal("creation must re-check verification/cache")
	}
}
