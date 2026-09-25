package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
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
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

type edgeFixture struct {
	ctx      context.Context
	pool     *pgxpool.Pool
	server   *server
	org      uuid.UUID
	user     uuid.UUID
	envelope []byte
}

func newEdgeFixture(t *testing.T) *edgeFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lockPool.Close)
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lock.Release)
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) })
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	f := &edgeFixture{ctx: ctx, pool: pool, org: uuid.New(), user: uuid.New(), envelope: []byte(`{"schemaVersion":1,"product":"tilecast-edge"}`)}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(true,'Edge Update Test',$1)`, f.org); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Owner','owner','test','owner')`, f.user); err != nil {
		t.Fatal(err)
	}
	f.server = &server{
		db:      pool,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		devices: devices.NewService(pool, devices.NewPresenceHub(), "http://localhost"),
	}
	return f
}

// screen adds a screen; family and architecture are what its player reported
// ("" for a player that does not report them).
func (f *edgeFixture) screen(t *testing.T, name, platform, family, architecture string, versionCode int64) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone,last_heartbeat_at,uptime_seconds) VALUES($1,$2,$3,$4,$5,'Test','Test','','0.1.0',1920,1080,1,'en-US','UTC',now(),3600)`, id, f.org, uuid.NewString(), name, platform); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO screen_player_status(screen_id,player_version_code,player_family,player_architecture) VALUES($1,$2,NULLIF($3,''),NULLIF($4,''))`, id, versionCode, family, architecture); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f *edgeFixture) edgeRelease(t *testing.T, arch string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO player_releases(id,platform,player_family,architecture,source,channel,version_code,version_name,release_notes,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_bytes,manifest_signature,state_schema_version,cache_status,verification_status,imported_by) VALUES($1,'linux','edge',$2,'upload','stable',2000,'0.2.0','',now(),'tilecast-edge-0.2.0-'||$2||'.tar.zst',4096,$3,'','{}'::jsonb,$4,'c2lnbmF0dXJl',6,'cached','verified',$5)`, id, arch, "abababababababababababababababababababababababababababababababab", f.envelope, f.user); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f *edgeFixture) electronRelease(t *testing.T) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO player_releases(id,platform,player_family,source,channel,version_code,version_name,release_notes,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_signature,cache_status,verification_status,imported_by) VALUES($1,'linux','electron-linux','upload','stable',9000,'0.9.0','',now(),'tilecast-player.AppImage',4096,$2,'','{}'::jsonb,'signature','cached','verified',$3)`, id, "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", f.user); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f *edgeFixture) deploy(t *testing.T, release uuid.UUID, screens ...uuid.UUID) (uuid.UUID, int) {
	t.Helper()
	body, _ := json.Marshal(deploymentInput{ReleaseID: release, Name: "Rollout", Mode: "install_now", ScreenIDs: screens})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/update-deployments", bytes.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), sessionContextKey, auth.Session{User: auth.User{ID: f.user, Role: "owner"}}))
	response := httptest.NewRecorder()
	f.server.createUpdateDeployment(response, request)
	if response.Code == http.StatusUnprocessableEntity {
		return uuid.Nil, 0
	}
	if response.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", response.Code, response.Body.String())
	}
	var created struct {
		Data struct {
			ID          uuid.UUID `json:"id"`
			TargetCount int       `json:"targetCount"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	return created.Data.ID, created.Data.TargetCount
}

func (f *edgeFixture) state(t *testing.T, deployment, screen uuid.UUID) string {
	t.Helper()
	var state string
	if err := f.pool.QueryRow(f.ctx, `SELECT state FROM screen_update_states WHERE deployment_id=$1 AND screen_id=$2`, deployment, screen).Scan(&state); err != nil {
		return "not_targeted"
	}
	return state
}

func (f *edgeFixture) asPlayer(screen uuid.UUID, request *http.Request) *http.Request {
	return request.WithContext(context.WithValue(request.Context(), deviceContextKey, devices.DevicePrincipal{ScreenID: screen, Enabled: true}))
}

func (f *edgeFixture) report(t *testing.T, deployment, screen uuid.UUID, body string) int {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/player/updates/"+deployment.String()+"/status", bytes.NewReader([]byte(body)))
	request = withURLParam(f.asPlayer(screen, request), "deploymentId", deployment.String())
	response := httptest.NewRecorder()
	f.server.playerUpdateStatus(response, request)
	return response.Code
}

func TestEdgeAndElectronReleasesNeverReachEachOthersScreens(t *testing.T) {
	f := newEdgeFixture(t)
	electron := f.screen(t, "Electron Lobby", "linux", "", "", 1000)
	edgeIntel := f.screen(t, "Edge Lobby", "linux", "edge", "x86_64", 1000)
	edgeArm := f.screen(t, "Edge Library", "linux", "edge", "aarch64", 1000)
	unreported := f.screen(t, "Edge before its first heartbeat", "linux", "edge", "", 1000)
	android := f.screen(t, "Fire TV", "fire-tv", "", "", 5)

	edge, count := f.deploy(t, f.edgeRelease(t, "x86_64"), electron, edgeIntel, edgeArm, unreported, android)
	if count != 3 {
		t.Fatalf("an Edge release targets exactly the three Edge screens, got %d", count)
	}
	for screen, want := range map[uuid.UUID]string{electron: "not_targeted", android: "not_targeted", edgeIntel: "pending", edgeArm: "incompatible", unreported: "incompatible"} {
		if got := f.state(t, edge, screen); got != want {
			t.Fatalf("edge deployment: screen state %q, want %q", got, want)
		}
	}
	var payload map[string]any
	if err := f.pool.QueryRow(f.ctx, `SELECT payload FROM player_commands WHERE screen_id=$1 AND type='install_player_update'`, edgeIntel).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["playerFamily"] != "edge" {
		t.Fatalf("the command names the release family: %#v", payload)
	}
	var armCommands int
	_ = f.pool.QueryRow(f.ctx, `SELECT count(*) FROM player_commands WHERE screen_id=ANY($1) AND type='install_player_update'`, []uuid.UUID{edgeArm, unreported, electron, android}).Scan(&armCommands)
	if armCommands != 0 {
		t.Fatalf("an incompatible or other-family screen got %d install commands", armCommands)
	}

	appImage, count := f.deploy(t, f.electronRelease(t), electron, edgeIntel, edgeArm, android)
	if count != 1 || f.state(t, appImage, electron) != "pending" || f.state(t, appImage, edgeIntel) != "not_targeted" {
		t.Fatalf("an Electron release reaches only the Electron screen (count %d)", count)
	}
	if id, _ := f.deploy(t, f.electronRelease2(t), edgeIntel); id != uuid.Nil {
		t.Fatal("an Electron release with only Edge targets must be refused")
	}
}

func (f *edgeFixture) electronRelease2(t *testing.T) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO player_releases(id,platform,player_family,source,channel,version_code,version_name,release_notes,published_at,apk_name,apk_size,apk_sha256,signing_certificate_sha256,manifest,manifest_signature,cache_status,verification_status,imported_by) VALUES($1,'linux','electron-linux','upload','stable',9001,'0.9.1','',now(),'tilecast-player.AppImage',4096,$2,'','{}'::jsonb,'signature','cached','verified',$3)`, id, "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef", f.user); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestEdgeUpdateSucceedsOnlyOnExplicitConfirmation(t *testing.T) {
	f := newEdgeFixture(t)
	screen := f.screen(t, "Edge Lobby", "linux", "edge", "x86_64", 1000)
	deployment, _ := f.deploy(t, f.edgeRelease(t, "x86_64"), screen)

	// The metadata carries the exact signed envelope for the screen to verify.
	release := uuid.Nil
	_ = f.pool.QueryRow(f.ctx, `SELECT release_id FROM update_deployments WHERE id=$1`, deployment).Scan(&release)
	request := withURLParam(f.asPlayer(screen, httptest.NewRequest(http.MethodGet, "/api/v1/player/updates/"+release.String(), nil)), "releaseId", release.String())
	response := httptest.NewRecorder()
	f.server.playerUpdateMetadata(response, request)
	var metadata struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &metadata); err != nil || response.Code != http.StatusOK {
		t.Fatalf("metadata status=%d body=%s", response.Code, response.Body.String())
	}
	if metadata.Data["playerFamily"] != "edge" || metadata.Data["architecture"] != "x86_64" || metadata.Data["signedManifest"] != base64.StdEncoding.EncodeToString(f.envelope) || metadata.Data["artifactPath"] == nil {
		t.Fatalf("edge metadata incomplete: %#v", metadata.Data)
	}

	// The candidate reconnects and heartbeats with the new version code for
	// longer than the settle threshold: that is not a confirmation.
	if code := f.report(t, deployment, screen, `{"state":"reconnecting"}`); code != http.StatusOK {
		t.Fatalf("reconnecting report status=%d", code)
	}
	heartbeat := `{"screenWidth":1920,"screenHeight":1080,"playerVersion":"0.2.0","playerVersionCode":2000,"uptimeSeconds":3600,"safeMode":false,"playerFamily":"edge","playerArchitecture":"x86_64"}`
	hb := f.asPlayer(screen, httptest.NewRequest(http.MethodPost, "/api/v1/player/heartbeat", bytes.NewReader([]byte(heartbeat))))
	recorder := httptest.NewRecorder()
	f.server.playerHeartbeat(recorder, hb)
	if recorder.Code != http.StatusOK {
		t.Fatalf("heartbeat status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	f.server.reconcileUpdateDeployments(f.ctx)
	if state := f.state(t, deployment, screen); state != "reconnecting" {
		t.Fatalf("a version-code heartbeat settled an Edge update: %s", state)
	}
	var family, architecture string
	_ = f.pool.QueryRow(f.ctx, `SELECT player_family,player_architecture FROM screen_player_status WHERE screen_id=$1`, screen).Scan(&family, &architecture)
	if family != "edge" || architecture != "x86_64" {
		t.Fatalf("heartbeat family not recorded: %q %q", family, architecture)
	}

	// The explicit confirmation settles it and completes the deployment.
	if code := f.report(t, deployment, screen, `{"state":"succeeded"}`); code != http.StatusOK {
		t.Fatalf("confirmation status=%d", code)
	}
	var status string
	_ = f.pool.QueryRow(f.ctx, `SELECT status FROM update_deployments WHERE id=$1`, deployment).Scan(&status)
	if f.state(t, deployment, screen) != "succeeded" || status != "completed" {
		t.Fatalf("confirmation did not settle: state=%s deployment=%s", f.state(t, deployment, screen), status)
	}

	// Only Edge reports its own success.
	electron := f.screen(t, "Electron Lobby", "linux", "", "", 1000)
	appImage, _ := f.deploy(t, f.electronRelease(t), electron)
	if code := f.report(t, appImage, electron, `{"state":"succeeded"}`); code != http.StatusUnprocessableEntity {
		t.Fatalf("an Electron self-reported success was accepted: %d", code)
	}
}

func TestEdgeRollbackIsAFailureThatPausesACanary(t *testing.T) {
	f := newEdgeFixture(t)
	first := f.screen(t, "Edge 1", "linux", "edge", "x86_64", 1000)
	second := f.screen(t, "Edge 2", "linux", "edge", "x86_64", 1000)
	body, _ := json.Marshal(deploymentInput{ReleaseID: f.edgeRelease(t, "x86_64"), Name: "Canary", Mode: "install_now", ScreenIDs: []uuid.UUID{first, second}, CanarySize: 1})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/update-deployments", bytes.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), sessionContextKey, auth.Session{User: auth.User{ID: f.user, Role: "owner"}}))
	response := httptest.NewRecorder()
	f.server.createUpdateDeployment(response, request)
	var created struct {
		Data struct {
			ID uuid.UUID `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &created)
	var canary uuid.UUID
	_ = f.pool.QueryRow(f.ctx, `SELECT screen_id FROM screen_update_states WHERE deployment_id=$1 AND is_canary`, created.Data.ID).Scan(&canary)
	if code := f.report(t, created.Data.ID, canary, `{"state":"failed","installerStatus":"rolled_back","error":"confirmation_timeout"}`); code != http.StatusOK {
		t.Fatalf("rollback report status=%d", code)
	}
	var status, phase string
	_ = f.pool.QueryRow(f.ctx, `SELECT status,rollout_phase FROM update_deployments WHERE id=$1`, created.Data.ID).Scan(&status, &phase)
	if status != "paused" || phase != "paused" {
		t.Fatalf("a rolled-back canary must pause the deployment: %s/%s", status, phase)
	}
}

func withURLParam(request *http.Request, name, value string) *http.Request {
	route := chi.RouteContext(request.Context())
	if route == nil {
		route = chi.NewRouteContext()
	}
	route.URLParams.Add(name, value)
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
}
