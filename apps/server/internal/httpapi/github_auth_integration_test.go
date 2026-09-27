package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/updates"
)

type githubAuthIntegrationProvider struct {
	token string
}

func (p *githubAuthIntegrationProvider) Releases(context.Context, string) (updates.ProviderResult, error) {
	return updates.ProviderResult{}, nil
}
func (p *githubAuthIntegrationProvider) Download(context.Context, string, int64) ([]byte, error) {
	return nil, errors.New("not implemented")
}
func (p *githubAuthIntegrationProvider) Open(context.Context, string) (*http.Response, error) {
	return nil, errors.New("not implemented")
}
func (p *githubAuthIntegrationProvider) BeginDeviceAuthorization(context.Context, string) (updates.DeviceAuthorization, error) {
	return updates.DeviceAuthorization{DeviceCode: "private-device-code", UserCode: "ABCD-EFGH", VerificationURI: "https://github.com/login/device", ExpiresIn: 15 * time.Minute, Interval: time.Millisecond}, nil
}
func (p *githubAuthIntegrationProvider) PollDeviceAuthorization(context.Context, string, string) (updates.DeviceTokenResult, error) {
	return updates.DeviceTokenResult{AccessToken: "private-access-token", Status: "connected"}, nil
}
func (p *githubAuthIntegrationProvider) Viewer(context.Context, string) (string, error) {
	return "tilecast-owner", nil
}
func (p *githubAuthIntegrationProvider) SetToken(token string) { p.token = token }

func TestGitHubDeviceAuthorizationAPIAndAudit(t *testing.T) {
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
	organizationID := uuid.New()
	userID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(true,'GitHub Auth Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Owner','owner','test','owner')`, userID); err != nil {
		t.Fatal(err)
	}

	provider := &githubAuthIntegrationProvider{}
	service, err := updates.NewService(pool, provider, updates.Config{Root: t.TempDir(), MaxAPKBytes: 1024, GitHubClientID: "client-123"})
	if err != nil {
		t.Fatal(err)
	}
	s := &server{db: pool, updates: service, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	session := auth.Session{User: auth.User{ID: userID, Role: "owner"}}

	startRequest := httptest.NewRequest(http.MethodPost, "/api/v1/player-releases/github/device", nil)
	startRequest = requestWithTestPrincipal(startRequest, session)
	startResponse := httptest.NewRecorder()
	s.startGitHubDeviceAuthorization(startResponse, startRequest)
	if startResponse.Code != http.StatusCreated {
		t.Fatalf("start status=%d body=%s", startResponse.Code, startResponse.Body.String())
	}
	var started struct {
		Data updates.GitHubDeviceStart `json:"data"`
	}
	if err = json.Unmarshal(startResponse.Body.Bytes(), &started); err != nil || started.Data.FlowID == "" || started.Data.UserCode != "ABCD-EFGH" {
		t.Fatalf("start response=%#v err=%v", started, err)
	}
	time.Sleep(5 * time.Millisecond)
	pollBody, _ := json.Marshal(githubDevicePollInput{FlowID: started.Data.FlowID})
	pollRequest := httptest.NewRequest(http.MethodPost, "/api/v1/player-releases/github/device/poll", bytes.NewReader(pollBody))
	pollRequest = requestWithTestPrincipal(pollRequest, session)
	pollResponse := httptest.NewRecorder()
	s.pollGitHubDeviceAuthorization(pollResponse, pollRequest)
	if pollResponse.Code != http.StatusOK || provider.token != "private-access-token" {
		t.Fatalf("poll status=%d body=%s tokenSet=%t", pollResponse.Code, pollResponse.Body.String(), provider.token != "")
	}
	var connectedAudit int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action='player_updates.github_connected' AND user_id=$1`, userID).Scan(&connectedAudit); err != nil || connectedAudit != 1 {
		t.Fatalf("connected audit count=%d err=%v", connectedAudit, err)
	}

	disconnectRequest := httptest.NewRequest(http.MethodDelete, "/api/v1/player-releases/github", nil)
	disconnectRequest = requestWithTestPrincipal(disconnectRequest, session)
	disconnectResponse := httptest.NewRecorder()
	s.disconnectGitHub(disconnectResponse, disconnectRequest)
	if disconnectResponse.Code != http.StatusNoContent || provider.token != "" {
		t.Fatalf("disconnect status=%d body=%s tokenSet=%t", disconnectResponse.Code, disconnectResponse.Body.String(), provider.token != "")
	}
	var disconnectedAudit int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action='player_updates.github_disconnected' AND user_id=$1`, userID).Scan(&disconnectedAudit); err != nil || disconnectedAudit != 1 {
		t.Fatalf("disconnected audit count=%d err=%v", disconnectedAudit, err)
	}
}
