package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/oauth"
)

// The PAT self-service loop: create a named token in the enrolled
// session, see it exactly once, list and search it by name without ever
// seeing the secret again, then revoke it through the grant endpoint.
func TestPATSelfServiceLoop(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := t.Context()
		authService := auth.NewService(env.pool, time.Hour)
		env.server.auth = authService
		env.server.oauth = oauth.NewService(env.pool)
		env.server.operationsLimiter = newRateLimiter(60, time.Minute)
		env.server.authLimiter = newRateLimiter(10, 10*time.Minute)
		env.server.cookieName = "tilecast_session"
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		hash, err := auth.HashPassword("correct horse battery staple")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,'owner',TRUE)`,
			uuid.New(), "Owner", "pat-loop-owner", hash); err != nil {
			t.Fatal(err)
		}
		result, err := authService.Login(ctx, auth.LoginInput{Username: "pat-loop-owner", Password: "correct horse battery staple"}, auth.MFAPolicyNone)
		if err != nil || result.Session == nil {
			t.Fatalf("login: %v", err)
		}
		session := *result.Session
		call := func(method, path string, csrf bool, body string) (int, map[string]any) {
			t.Helper()
			request, _ := http.NewRequest(method, router.URL+path, strings.NewReader(body))
			request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
			if csrf {
				request.Header.Set("X-CSRF-Token", session.CSRFToken)
			}
			response, err := router.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			raw, _ := io.ReadAll(response.Body)
			decoded := map[string]any{}
			_ = json.Unmarshal(raw, &decoded)
			return response.StatusCode, decoded
		}

		create, _ := json.Marshal(map[string]any{"name": "ci-deploy", "scopes": []string{"read"}, "expiresInDays": 30})
		if status, _ := call(http.MethodPost, "/api/v1/me/security/pats", false, string(create)); status == http.StatusCreated {
			t.Fatal("PAT creation succeeded without a CSRF token")
		}
		status, created := call(http.MethodPost, "/api/v1/me/security/pats", true, string(create))
		if status != http.StatusCreated {
			t.Fatalf("create PAT = %d %v", status, created)
		}
		data := created["data"].(map[string]any)
		token, _ := data["token"].(string)
		if !strings.HasPrefix(token, "tcp_") {
			t.Fatalf("PAT token has wrong shape: %q", token)
		}
		patID := data["pat"].(map[string]any)["id"].(string)

		for _, shape := range []string{`{"name":"","scopes":["read"],"expiresInDays":30}`, `{"name":"x","scopes":["read"],"expiresInDays":-1}`} {
			if status, body := call(http.MethodPost, "/api/v1/me/security/pats", true, shape); status != http.StatusBadRequest {
				t.Fatalf("invalid PAT shape = %d %v, want 400", status, body)
			}
		}

		status, listed := call(http.MethodGet, "/api/v1/me/security/pats?search=DEPLOY", false, "")
		if status != http.StatusOK {
			t.Fatalf("list PATs = %d %v", status, listed)
		}
		pats := listed["data"].(map[string]any)["pats"].([]any)
		if len(pats) != 1 {
			t.Fatalf("PAT search = %v, want the one token", pats)
		}
		entry := pats[0].(map[string]any)
		if entry["name"] != "ci-deploy" || entry["expiresAt"] == nil {
			t.Fatalf("PAT entry = %v, want name and expiry", entry)
		}
		if raw, _ := json.Marshal(listed); strings.Contains(string(raw), token) {
			t.Fatal("list response leaks the plaintext token")
		}

		if status, _ := call(http.MethodGet, "/api/v1/me/security/pats?search=nope", false, ""); status != http.StatusOK {
			t.Fatalf("empty search = %d", status)
		}

		if status, body := call(http.MethodDelete, "/api/v1/me/security/grants/"+patID, true, ""); status != http.StatusNoContent {
			t.Fatalf("revoke PAT = %d %v", status, body)
		}
		status, listed = call(http.MethodGet, "/api/v1/me/security/pats", false, "")
		if status != http.StatusOK {
			t.Fatalf("list after revoke = %d", status)
		}
		after := listed["data"].(map[string]any)["pats"].([]any)
		if len(after) != 1 || after[0].(map[string]any)["revokedAt"] == nil {
			t.Fatalf("revoked PAT vanished: %v", after)
		}
	})
}
