package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleconnections"
)

// TestPluginConnectionsAPI drives the connection routes through the
// production router: reading needs plugins.use, every change needs
// plugins.manage and CSRF, and consents change only through their own
// operation.
func TestPluginConnectionsAPI(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		authService := auth.NewService(env.pool, time.Hour)
		env.server.auth = authService
		env.server.cookieName = "tilecast_session"
		env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithPlugins(sampleconnections.New()))
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		sessions := map[string]auth.Session{}
		var ownerID uuid.UUID
		for _, role := range []string{"owner", "editor", "viewer"} {
			hash, err := auth.HashPassword("correct horse battery staple")
			if err != nil {
				t.Fatal(err)
			}
			id := uuid.New()
			if role == "owner" {
				ownerID = id
			}
			if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,$5,TRUE)`,
				id, role, "connections-"+role, hash, role); err != nil {
				t.Fatal(err)
			}
			result, err := authService.Login(ctx, auth.LoginInput{Username: "connections-" + role, Password: "correct horse battery staple"}, auth.MFAPolicyNone)
			if err != nil || result.Session == nil {
				t.Fatalf("login %s: %v", role, err)
			}
			sessions[role] = *result.Session
		}
		if _, _, err := env.server.plugins.Install(ctx, sampleconnections.ID, ownerID); err != nil {
			t.Fatal(err)
		}
		call := func(role, method, path string, csrf bool, body string) (int, map[string]any) {
			t.Helper()
			request, err := http.NewRequest(method, router.URL+path, strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			session := sessions[role]
			request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
			if csrf {
				request.Header.Set("X-CSRF-Token", session.CSRFToken)
			}
			if body != "" {
				request.Header.Set("Content-Type", "application/json")
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
		code := func(body map[string]any) string {
			envelope, _ := body["error"].(map[string]any)
			value, _ := envelope["code"].(string)
			return value
		}
		base := "/api/v1/plugins/" + sampleconnections.ID + "/connections"
		create := `{"definition":"lan","name":"Gateway","origin":"http://gateway.lan:8080"}`
		for _, role := range []string{"viewer", "editor"} {
			if status, _ := call(role, http.MethodPost, base, true, create); status != http.StatusForbidden {
				t.Fatalf("%s create = %d", role, status)
			}
		}
		if status, body := call("owner", http.MethodPost, base, false, create); status != http.StatusForbidden || code(body) != "csrf_failed" {
			t.Fatalf("create without CSRF = %d %v", status, body)
		}
		status, body := call("owner", http.MethodPost, base, true, create)
		if status != http.StatusCreated {
			t.Fatalf("create = %d %v", status, body)
		}
		connection := body["data"].(map[string]any)
		id := connection["id"].(string)
		if connection["status"] != plugins.ReasonPrivateNetworkConsent {
			t.Fatalf("status = %v", connection["status"])
		}
		// A general save cannot carry a consent.
		if status, body = call("owner", http.MethodPut, base+"/"+id, true, `{"name":"Gateway","origin":"http://gateway.lan:8080","expectedRevision":1,"consents":{"plainHttp":true}}`); status != http.StatusBadRequest {
			t.Fatalf("save with consents = %d %v", status, body)
		}
		consents := fmt.Sprintf(`{"privateNetwork":true,"plainHttp":true,"plaintextSecret":false,"expectedRevision":%v}`, connection["revision"])
		if status, _ = call("editor", http.MethodPut, base+"/"+id+"/consents", true, consents); status != http.StatusForbidden {
			t.Fatalf("editor consents = %d", status)
		}
		if status, body = call("owner", http.MethodPut, base+"/"+id+"/consents", true, consents); status != http.StatusOK || body["data"].(map[string]any)["status"] != plugins.ConnectionReady {
			t.Fatalf("consents = %d %v", status, body)
		}
		// Every signed-in role reads; nothing in a record is a credential.
		if status, body = call("viewer", http.MethodGet, base, false, ""); status != http.StatusOK || body["data"].(map[string]any)["total"].(float64) != 1 {
			t.Fatalf("viewer list = %d %v", status, body)
		}
		if status, body = call("viewer", http.MethodGet, base+"/"+uuid.NewString(), false, ""); status != http.StatusNotFound || code(body) != "plugin_connection_not_found" {
			t.Fatalf("missing = %d %v", status, body)
		}
		if status, _ = call("viewer", http.MethodDelete, base+"/"+id, true, ""); status != http.StatusForbidden {
			t.Fatalf("viewer delete = %d", status)
		}
		if status, _ = call("owner", http.MethodDelete, base+"/"+id, true, ""); status != http.StatusNoContent {
			t.Fatalf("delete = %d", status)
		}
		if status, body = call("owner", http.MethodGet, "/api/v1/plugins/countdown_bar/connections", false, ""); status != http.StatusNotFound || code(body) != "plugin_not_found" {
			t.Fatalf("a plugin without connections = %d %v", status, body)
		}
	})
}

// TestPluginConnectionOAuthRoutes drives the OAuth routes through the
// production router. The provider's redirect carries no Studio session (the
// cookie is SameSite=Strict), so the callback changes nothing and returns
// the fixed Studio page; completion needs the session and CSRF.
func TestPluginConnectionOAuthRoutes(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		authService := auth.NewService(env.pool, time.Hour)
		env.server.auth = authService
		env.server.cookieName = "tilecast_session"
		if _, err := env.pool.Exec(ctx, `TRUNCATE plugin_secret_deks CASCADE`); err != nil {
			t.Fatal(err)
		}
		ring, _, err := pluginsecrets.LoadOrCreate(filepath.Join(t.TempDir(), "kek.json"))
		if err != nil {
			t.Fatal(err)
		}
		env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithPlugins(sampleconnections.New()),
			plugins.WithSecrets(pluginsecrets.NewStore(env.pool, ring, nil)), plugins.WithPublicURL("https://signs.example.org"))
		env.server.operationsLimiter = newRateLimiter(60, time.Minute)
		router := httptest.NewServer(env.server.routes())
		defer router.Close()
		sessions := map[string]auth.Session{}
		var ownerID uuid.UUID
		for _, role := range []string{"owner", "editor"} {
			hash, err := auth.HashPassword("correct horse battery staple")
			if err != nil {
				t.Fatal(err)
			}
			id := uuid.New()
			if role == "owner" {
				ownerID = id
			}
			if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,$5,TRUE)`,
				id, role, "oauth-"+role, hash, role); err != nil {
				t.Fatal(err)
			}
			result, err := authService.Login(ctx, auth.LoginInput{Username: "oauth-" + role, Password: "correct horse battery staple"}, auth.MFAPolicyNone)
			if err != nil || result.Session == nil {
				t.Fatalf("login %s: %v", role, err)
			}
			sessions[role] = *result.Session
		}
		if _, _, err := env.server.plugins.Install(ctx, sampleconnections.ID, ownerID); err != nil {
			t.Fatal(err)
		}
		client := router.Client()
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		call := func(role, method, path string, csrf bool, body string) (*http.Response, map[string]any) {
			t.Helper()
			request, err := http.NewRequest(method, router.URL+path, strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			if session, ok := sessions[role]; ok {
				request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
				if csrf {
					request.Header.Set("X-CSRF-Token", session.CSRFToken)
				}
			}
			if body != "" {
				request.Header.Set("Content-Type", "application/json")
			}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			raw, _ := io.ReadAll(response.Body)
			decoded := map[string]any{}
			_ = json.Unmarshal(raw, &decoded)
			return response, decoded
		}
		base := "/api/v1/plugins/" + sampleconnections.ID + "/connections"
		response, body := call("owner", http.MethodPost, base, true, `{"definition":"calendar_public","name":"Calendar","clientId":"public-client"}`)
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("create = %d %v", response.StatusCode, body)
		}
		connection := body["data"].(map[string]any)
		id := connection["id"].(string)
		oauth := connection["oauth"].(map[string]any)
		if oauth["callbackUrl"] != "https://signs.example.org"+base+"/"+id+"/callback" || oauth["connectAvailable"] != true {
			t.Fatalf("oauth = %v", oauth)
		}
		if response, _ = call("editor", http.MethodPost, base+"/"+id+"/oauth/start", true, ""); response.StatusCode != http.StatusForbidden {
			t.Fatalf("editor start = %d", response.StatusCode)
		}
		if response, _ = call("owner", http.MethodPost, base+"/"+id+"/oauth/start", false, ""); response.StatusCode != http.StatusForbidden {
			t.Fatalf("start without CSRF = %d", response.StatusCode)
		}
		response, body = call("owner", http.MethodPost, base+"/"+id+"/oauth/start", true, "")
		authorization, _ := body["data"].(map[string]any)["authorizationUrl"].(string)
		if response.StatusCode != http.StatusOK || !strings.HasPrefix(authorization, "https://auth.example.com/authorize?") || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("start = %d %v", response.StatusCode, body)
		}
		// The provider's redirect: no session, no change, a fixed page.
		response, _ = call("", http.MethodGet, base+"/"+id+"/callback?state=abc&code=xyz&returnTo=https%3A%2F%2Fevil.example", false, "")
		location := response.Header.Get("Location")
		if response.StatusCode != http.StatusSeeOther || !strings.HasPrefix(location, "/plugins/sample-connections/connections/"+id+"#oauth=") ||
			strings.Contains(location, "evil") || response.Header.Get("Referrer-Policy") != "no-referrer" || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("callback = %d %s %v", response.StatusCode, location, response.Header)
		}
		// Completion needs the session and CSRF, and a valid state.
		if response, _ = call("", http.MethodPost, base+"/"+id+"/oauth/complete", false, `{"state":"abc","code":"xyz"}`); response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("complete without a session = %d", response.StatusCode)
		}
		if response, _ = call("owner", http.MethodPost, base+"/"+id+"/oauth/complete", false, `{"state":"abc","code":"xyz"}`); response.StatusCode != http.StatusForbidden {
			t.Fatalf("complete without CSRF = %d", response.StatusCode)
		}
		response, body = call("owner", http.MethodPost, base+"/"+id+"/oauth/complete", true, `{"state":"abc","code":"xyz","returnTo":"https://evil.example"}`)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("complete with an unknown member = %d %v", response.StatusCode, body)
		}
		response, body = call("owner", http.MethodPost, base+"/"+id+"/oauth/complete", true, `{"state":"abc","code":"xyz"}`)
		failure, _ := body["error"].(map[string]any)
		details, _ := failure["details"].(map[string]any)
		if response.StatusCode != http.StatusBadRequest || failure["code"] != "plugin_oauth_failed" || details["reason"] != plugins.OAuthFailInvalidState {
			t.Fatalf("complete with a wrong state = %d %v", response.StatusCode, body)
		}
		response, body = call("owner", http.MethodPost, base+"/"+id+"/oauth/disconnect", true, "")
		if response.StatusCode != http.StatusOK || body["data"].(map[string]any)["oauth"].(map[string]any)["status"] != plugins.OAuthNotConnected {
			t.Fatalf("disconnect = %d %v", response.StatusCode, body)
		}
	})
}
