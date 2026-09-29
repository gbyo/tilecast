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

func TestIOSBrowserApprovalCreatesStudioSession(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := t.Context()
		env.server.auth = auth.NewService(env.pool, time.Hour)
		env.server.oauth = oauth.NewService(env.pool)
		env.server.operationsLimiter = newRateLimiter(60, time.Minute)
		env.server.authLimiter = newRateLimiter(10, 10*time.Minute)
		env.server.cookieName = "tilecast_session"
		server := httptest.NewServer(env.server.routes())
		defer server.Close()

		hash, err := auth.HashPassword("correct horse battery staple")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,'owner',TRUE)`,
			uuid.New(), "Owner", "ios-owner", hash); err != nil {
			t.Fatal(err)
		}
		login, err := env.server.auth.Login(ctx, auth.LoginInput{Username: "ios-owner", Password: "correct horse battery staple"}, auth.MFAPolicyNone)
		if err != nil || login.Session == nil {
			t.Fatalf("login: %v", err)
		}
		verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
		digest := sha256.Sum256([]byte(verifier))
		challenge := base64.RawURLEncoding.EncodeToString(digest[:])
		body, _ := json.Marshal(map[string]string{
			"client": oauth.ClientIOS, "redirectUri": oauth.IOSRedirectURI,
			"scope": "read write admin", "state": "ios-state", "challenge": challenge, "method": "S256",
		})
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/oauth/approve", strings.NewReader(string(body)))
		request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: login.Session.Token})
		request.Header.Set("X-CSRF-Token", login.Session.CSRFToken)
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			raw, _ := io.ReadAll(response.Body)
			t.Fatalf("approve: %d %s", response.StatusCode, raw)
		}
		var approved struct {
			Data struct {
				RedirectURI string `json:"redirectUri"`
			} `json:"data"`
		}
		if err := json.NewDecoder(response.Body).Decode(&approved); err != nil {
			t.Fatal(err)
		}
		callback, err := url.Parse(approved.Data.RedirectURI)
		if err != nil || callback.Scheme != "tilecast-ios" || callback.Query().Get("state") != "ios-state" {
			t.Fatalf("callback: %v %v", callback, err)
		}
		exchange, _ := json.Marshal(map[string]string{
			"grant_type": "authorization_code", "client_id": oauth.ClientIOS,
			"code": callback.Query().Get("code"), "redirect_uri": oauth.IOSRedirectURI, "code_verifier": verifier,
		})
		request, _ = http.NewRequest(http.MethodPost, server.URL+"/api/v1/oauth/token", strings.NewReader(string(exchange)))
		response, err = server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("iOS token endpoint status = %d", response.StatusCode)
		}
		request, _ = http.NewRequest(http.MethodPost, server.URL+"/api/v1/oauth/ios-session", strings.NewReader(string(exchange)))
		response, err = server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			raw, _ := io.ReadAll(response.Body)
			t.Fatalf("session: %d %s", response.StatusCode, raw)
		}
		cookies := response.Cookies()
		if len(cookies) != 1 || cookies[0].Name != "tilecast_session" || !cookies[0].HttpOnly {
			t.Fatalf("session cookie: %+v", cookies)
		}
		var activeGrants int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM api_grants WHERE client_id=$1 AND revoked_at IS NULL`, oauth.ClientIOS).Scan(&activeGrants); err != nil || activeGrants != 0 {
			t.Fatalf("active iOS grants = %d: %v", activeGrants, err)
		}
		request, _ = http.NewRequest(http.MethodGet, server.URL+"/api/v1/auth/status", nil)
		request.AddCookie(cookies[0])
		response, err = server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var status struct {
			Data struct {
				Authenticated bool `json:"authenticated"`
			} `json:"data"`
		}
		if err := json.NewDecoder(response.Body).Decode(&status); err != nil || !status.Data.Authenticated {
			t.Fatalf("status: %+v %v", status, err)
		}
		request, _ = http.NewRequest(http.MethodPost, server.URL+"/api/v1/oauth/ios-session", strings.NewReader(string(exchange)))
		response, err = server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode == http.StatusOK {
			t.Fatal("replayed code created another session")
		}
	})
}
