package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/oauth"
)

// The browser approval loop for a loopback operator: describe the request,
// approve it in the enrolled session, exchange the code with PKCE, rotate
// once, then list and revoke the grant.
func TestOAuthBrowserApprovalLoop(t *testing.T) {
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
			uuid.New(), "Owner", "oauth-loop-owner", hash); err != nil {
			t.Fatal(err)
		}
		result, err := authService.Login(ctx, auth.LoginInput{Username: "oauth-loop-owner", Password: "correct horse battery staple"}, auth.MFAPolicyNone)
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

		verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
		digest := sha256.Sum256([]byte(verifier))
		challenge := base64.RawURLEncoding.EncodeToString(digest[:])
		query := url.Values{
			"client_id":             {"tilecast-cli"},
			"redirect_uri":          {"http://127.0.0.1:8471/callback"},
			"scope":                 {"read write"},
			"state":                 {"loop-1"},
			"code_challenge":        {challenge},
			"code_challenge_method": {"S256"},
		}
		status, describe := call(http.MethodGet, "/api/v1/oauth/authorize?"+query.Encode(), false, "")
		if status != http.StatusOK {
			t.Fatalf("authorize = %d %v", status, describe)
		}
		data := describe["data"].(map[string]any)
		if data["client"].(map[string]any)["name"] != "tilecast-cli" {
			t.Fatalf("authorize client = %v", data)
		}
		decision, _ := json.Marshal(map[string]string{
			"client": "tilecast-cli", "redirectUri": "http://127.0.0.1:8471/callback",
			"scope": "read write", "state": "loop-1", "challenge": challenge, "method": "S256",
		})
		status, approved := call(http.MethodPost, "/api/v1/oauth/approve", true, string(decision))
		if status != http.StatusOK {
			t.Fatalf("approve = %d %v", status, approved)
		}
		redirect, _ := url.Parse(approved["data"].(map[string]any)["redirectUri"].(string))
		if redirect.Host != "127.0.0.1:8471" || redirect.Query().Get("state") != "loop-1" {
			t.Fatalf("approve redirect = %v", redirect)
		}
		code := redirect.Query().Get("code")
		if code == "" {
			t.Fatal("approve returned no code")
		}
		exchange, _ := json.Marshal(map[string]string{
			"grant_type": "authorization_code", "client_id": "tilecast-cli",
			"code": code, "redirect_uri": "http://127.0.0.1:8471/callback", "code_verifier": verifier,
		})
		public := func(body string) (int, map[string]any) {
			t.Helper()
			request, _ := http.NewRequest(http.MethodPost, router.URL+"/api/v1/oauth/token", strings.NewReader(body))
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
		status, issued := public(string(exchange))
		if status != http.StatusOK {
			t.Fatalf("token = %d %v", status, issued)
		}
		tokens := issued["data"].(map[string]any)
		refresh, _ := tokens["refresh_token"].(string)
		if !strings.HasPrefix(tokens["access_token"].(string), "tca_") || !strings.HasPrefix(refresh, "tcr_") {
			t.Fatalf("token prefixes = %v", tokens)
		}
		rotate, _ := json.Marshal(map[string]string{"grant_type": "refresh_token", "refresh_token": refresh})
		if status, _ := public(string(rotate)); status != http.StatusOK {
			t.Fatalf("refresh = %d", status)
		}
		status, listed := call(http.MethodGet, "/api/v1/me/security/grants", false, "")
		if status != http.StatusOK {
			t.Fatalf("grants = %d %v", status, listed)
		}
		grants := listed["data"].(map[string]any)["grants"].([]any)
		if len(grants) != 1 {
			t.Fatalf("grants = %v", listed)
		}
		grantID := grants[0].(map[string]any)["id"].(string)
		status, _ = call(http.MethodDelete, "/api/v1/me/security/grants/"+grantID, true, "")
		if status != http.StatusNoContent {
			t.Fatalf("revoke = %d", status)
		}
		status, listed = call(http.MethodGet, "/api/v1/me/security/grants", false, "")
		if status != http.StatusOK || listed["data"].(map[string]any)["grants"].([]any)[0].(map[string]any)["revokedAt"] == nil {
			t.Fatalf("grant still live = %d %v", status, listed)
		}
	})
}
