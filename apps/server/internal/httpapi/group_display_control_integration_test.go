package httpapi

import (
	"bytes"
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
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

func groupDisplayControlRequest(method, path string, groupID, userID uuid.UUID, body []byte) *http.Request {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	route := chi.NewRouteContext()
	route.URLParams.Add("id", groupID.String())
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
	return requestWithTestPrincipal(request, auth.Session{User: auth.User{ID: userID, Role: "owner"}})
}

func TestDisplayGroupControlPreviewsMixedCapabilitiesAndQueuesOnlySupportedPlayers(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}

	organizationID, userID, groupID := uuid.New(), uuid.New(), uuid.New()
	supportedID, unsupportedID := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id)VALUES(TRUE,'Display Control Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active)VALUES($1,'Owner','owner','unused','owner',TRUE)`, userID); err != nil {
		t.Fatal(err)
	}
	insertScreen := func(id uuid.UUID, name string) {
		t.Helper()
		if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,$4,'linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, id, organizationID, uuid.NewString(), name); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash)VALUES($1,$2,$3,$4)`, uuid.New(), id, uuid.NewString(), make([]byte, 32)); err != nil {
			t.Fatal(err)
		}
	}
	insertScreen(supportedID, "CEC Lobby")
	insertScreen(unsupportedID, "Unmanaged Lobby")
	if _, err = pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id,display_control_provider,display_control_capabilities)VALUES($1,'hdmi_cec','{"power":"hdmi_cec"}'::jsonb),($2,'unsupported','{}'::jsonb)`, supportedID, unsupportedID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by)VALUES($1,$2,'Lobby wall',$3)`, groupID, organizationID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by)VALUES($1,$2,$3),($1,$4,$3)`, groupID, supportedID, userID, unsupportedID); err != nil {
		t.Fatal(err)
	}

	s := &server{
		db:         pool,
		devices:    devices.NewService(pool, devices.NewPresenceHub(), "http://localhost"),
		logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		operations: OperationsConfig{MaxPendingCommands: 10, DefaultCommandExpiryMinutes: 10, CommandRetentionDays: 30},
	}
	previewResponse := httptest.NewRecorder()
	s.previewGroupDisplayControl(previewResponse, groupDisplayControlRequest(http.MethodGet, "/api/v1/screen-groups/"+groupID.String()+"/display-control/preview?commandType=display_power_on", groupID, userID, nil))
	if previewResponse.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", previewResponse.Code, previewResponse.Body.String())
	}
	var previewEnvelope struct {
		Data groupDisplayControlPreview `json:"data"`
	}
	if err = json.Unmarshal(previewResponse.Body.Bytes(), &previewEnvelope); err != nil {
		t.Fatal(err)
	}
	if previewEnvelope.Data.SelectedCount != 2 || previewEnvelope.Data.SupportedCount != 1 || previewEnvelope.Data.UnsupportedCount != 1 || previewEnvelope.Data.EligibleCount != 1 || previewEnvelope.Data.Fingerprint == "" {
		t.Fatalf("unexpected mixed capability preview: %#v", previewEnvelope.Data)
	}

	body, _ := json.Marshal(groupDisplayControlApplyInput{CommandType: "display_power_on", Fingerprint: previewEnvelope.Data.Fingerprint})
	applyResponse := httptest.NewRecorder()
	s.applyGroupDisplayControl(applyResponse, groupDisplayControlRequest(http.MethodPost, "/api/v1/screen-groups/"+groupID.String()+"/display-control", groupID, userID, body))
	if applyResponse.Code != http.StatusAccepted {
		t.Fatalf("apply status=%d body=%s", applyResponse.Code, applyResponse.Body.String())
	}
	var queued int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM player_commands WHERE type='display_power_on'`).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("queued display commands=%d err=%v, want one supported Player", queued, err)
	}

	if _, err = pool.Exec(ctx, `UPDATE screen_player_status SET display_control_capabilities='{}'::jsonb WHERE screen_id=$1`, supportedID); err != nil {
		t.Fatal(err)
	}
	staleBody, _ := json.Marshal(groupDisplayControlApplyInput{CommandType: "display_power_on", Fingerprint: previewEnvelope.Data.Fingerprint})
	staleResponse := httptest.NewRecorder()
	s.applyGroupDisplayControl(staleResponse, groupDisplayControlRequest(http.MethodPost, "/api/v1/screen-groups/"+groupID.String()+"/display-control", groupID, userID, staleBody))
	if staleResponse.Code != http.StatusConflict {
		t.Fatalf("stale apply status=%d body=%s, want conflict", staleResponse.Code, staleResponse.Body.String())
	}
}
