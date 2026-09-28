package httpapi

import (
	"context"
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
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleplugin"
)

// A plugin chooses an access level; the production router applies session,
// role, and CSRF checks before its handler runs.
func TestPluginRoutesUseHostAuthorization(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		authService := auth.NewService(env.pool, time.Hour)
		env.server.auth = authService
		env.server.cookieName = "tilecast_session"
		env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithPlugins(sampleplugin.New()))
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		sessions := map[string]auth.Session{}
		for _, role := range []string{"owner", "editor", "viewer"} {
			hash, err := auth.HashPassword("correct horse battery staple")
			if err != nil {
				t.Fatal(err)
			}
			username := "plugin-routes-" + role
			if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,$5,TRUE)`,
				uuid.New(), role, username, hash, role); err != nil {
				t.Fatal(err)
			}
			result, err := authService.Login(ctx, auth.LoginInput{Username: username, Password: "correct horse battery staple"}, auth.MFAPolicyNone)
			if err != nil || result.Session == nil {
				t.Fatalf("login %s: %v", role, err)
			}
			sessions[role] = *result.Session
		}
		call := func(role, method, path string, csrf bool, body string) (int, map[string]any) {
			t.Helper()
			request, _ := http.NewRequest(method, router.URL+path, strings.NewReader(body))
			if session, ok := sessions[role]; ok {
				request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
				if csrf {
					request.Header.Set("X-CSRF-Token", session.CSRFToken)
				}
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

		if status, _ := call("", http.MethodGet, "/api/v1/plugins/sample-tally/items", false, ""); status != http.StatusUnauthorized {
			t.Fatalf("anonymous read = %d", status)
		}
		if status, _ := call("viewer", http.MethodGet, "/api/v1/plugins/sample-tally/items", false, ""); status != http.StatusOK {
			t.Fatalf("viewer read = %d", status)
		}
		if status, body := call("editor", http.MethodPost, "/api/v1/plugins/sample-tally/items", true, `{"label":"x"}`); status != http.StatusForbidden || code(body) != "insufficient_role" {
			t.Fatalf("editor write = %d %v", status, body)
		}
		if status, body := call("owner", http.MethodPost, "/api/v1/plugins/sample-tally/items", false, `{"label":"x"}`); status != http.StatusForbidden || code(body) != "csrf_failed" {
			t.Fatalf("owner write without CSRF = %d %v", status, body)
		}
		// The plugin's own errors map to the standard envelope.
		if status, body := call("owner", http.MethodPost, "/api/v1/plugins/sample-tally/items", true, `{"label":"x"}`); status != http.StatusConflict || code(body) != "plugin_not_installed" {
			t.Fatalf("write before install = %d %v", status, body)
		}
		if status, body := call("owner", http.MethodPost, "/api/v1/plugins/sample-tally/items", true, `{"label":"x","extra":1}`); status != http.StatusBadRequest || code(body) != "invalid_request" {
			t.Fatalf("unknown field = %d %v", status, body)
		}
		if status, body := call("owner", http.MethodDelete, "/api/v1/plugins/sample-tally/items/not-a-uuid", true, ""); status != http.StatusNotFound || code(body) != "not_found" {
			t.Fatalf("malformed id = %d %v", status, body)
		}
		if status, body := call("owner", http.MethodDelete, "/api/v1/plugins/sample-tally/items/"+uuid.NewString(), true, ""); status != http.StatusNotFound || code(body) != "plugin_instance_not_found" {
			t.Fatalf("missing item = %d %v", status, body)
		}
		if status, _ := call("owner", http.MethodPost, "/api/v1/plugins/sample_tally/install", true, ""); status != http.StatusCreated {
			t.Fatalf("install = %d", status)
		}
		if status, body := call("owner", http.MethodPost, "/api/v1/plugins/sample-tally/items", true, `{"label":""}`); status != http.StatusBadRequest || code(body) != "invalid_plugin_configuration" {
			t.Fatalf("invalid item = %d %v", status, body)
		}
		if status, body := call("owner", http.MethodPost, "/api/v1/plugins/sample-tally/items", true, `{"label":"Lobby"}`); status != http.StatusCreated {
			t.Fatalf("create = %d %v", status, body)
		}
		// Session access: any role, CSRF only on unsafe methods, principal passed through.
		// The host translates the unified management principal into the frozen
		// Plugin API principal, so the plugin sees the user ID and role with
		// no implementation change on its side.
		if status, body := call("viewer", http.MethodGet, "/api/v1/plugins/sample-tally/whoami", false, ""); status != http.StatusOK ||
			body["data"].(map[string]any)["role"] != "viewer" ||
			body["data"].(map[string]any)["userId"] != sessions["viewer"].User.ID.String() {
			t.Fatalf("whoami = %d %v", status, body)
		}
		// Removal is blocked by the plugin's own resources.
		status, body := call("owner", http.MethodDelete, "/api/v1/plugins/sample_tally/installation", true, "")
		resources, _ := body["error"].(map[string]any)["details"].(map[string]any)["resources"].([]any)
		if status != http.StatusConflict || code(body) != "plugin_in_use" || len(resources) != 1 ||
			resources[0].(map[string]any)["resolution"] != "delete" {
			t.Fatalf("remove in use = %d %v", status, body)
		}
	})
}

// A plugin route a core route already answers stops startup instead of being
// shadowed silently.
func TestPluginRouteShadowingACoreRouteIsRefused(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithPlugins(shadowingPlugin{sampleplugin.New()}))
		defer func() {
			recovered := recover()
			err, _ := recovered.(error)
			if err == nil || !strings.Contains(err.Error(), "overlaps the core route") {
				t.Fatalf("recovered %v", recovered)
			}
		}()
		env.server.routes()
	})
}

type shadowingPlugin struct{ *sampleplugin.Plugin }

func (p shadowingPlugin) Routes(router plugin.Router) {
	router.Handle(http.MethodPost, "/plugins/sample-tally/install", plugin.AccessManager,
		func(http.ResponseWriter, *http.Request) error { return nil })
}

// A route declaring the operations rate limit through generic metadata gets
// the host's session, role, CSRF, and operations-limiter handling, exactly
// like the Emergency Alerts Check Now endpoint.
func TestPluginOperationsRateLimit(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		authService := auth.NewService(env.pool, time.Hour)
		env.server.auth = authService
		env.server.cookieName = "tilecast_session"
		env.server.operationsLimiter = newRateLimiter(60, time.Minute)
		env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithPlugins(rateLimitedPlugin{sampleplugin.New()}))
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		sessions := map[string]auth.Session{}
		for _, role := range []string{"owner", "viewer"} {
			hash, err := auth.HashPassword("correct horse battery staple")
			if err != nil {
				t.Fatal(err)
			}
			username := "plugin-ratelimit-" + role
			if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,$5,TRUE)`,
				uuid.New(), role, username, hash, role); err != nil {
				t.Fatal(err)
			}
			result, err := authService.Login(ctx, auth.LoginInput{Username: username, Password: "correct horse battery staple"}, auth.MFAPolicyNone)
			if err != nil || result.Session == nil {
				t.Fatalf("login %s: %v", role, err)
			}
			sessions[role] = *result.Session
		}
		call := func(role string, csrf bool) (int, map[string]any) {
			t.Helper()
			request, _ := http.NewRequest(http.MethodPost, router.URL+"/api/v1/plugins/sample-tally/check-now", nil)
			if session, ok := sessions[role]; ok {
				request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
				if csrf {
					request.Header.Set("X-CSRF-Token", session.CSRFToken)
				}
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

		if status, _ := call("", false); status != http.StatusUnauthorized {
			t.Fatalf("anonymous check-now = %d", status)
		}
		if status, body := call("viewer", true); status != http.StatusForbidden || code(body) != "insufficient_role" {
			t.Fatalf("viewer check-now = %d %v", status, body)
		}
		if status, body := call("owner", false); status != http.StatusForbidden || code(body) != "csrf_failed" {
			t.Fatalf("owner check-now without CSRF = %d %v", status, body)
		}
		if status, _ := call("owner", true); status != http.StatusOK {
			t.Fatalf("owner check-now = %d", status)
		}
		// The operations limiter allows 60 requests a minute: exhaust it and
		// the same request is refused without reaching the handler.
		limited := false
		for i := 0; i < 70; i++ {
			status, body := call("owner", true)
			if status == http.StatusTooManyRequests && code(body) == "rate_limited" {
				limited = true
				break
			}
			if status != http.StatusOK {
				t.Fatalf("check-now before limit = %d %v", status, body)
			}
		}
		if !limited {
			t.Fatal("operations rate limit never refused the request")
		}
	})
}

type rateLimitedPlugin struct{ *sampleplugin.Plugin }

func (p rateLimitedPlugin) Routes(router plugin.Router) {
	p.Plugin.Routes(router)
	router.HandleWithRateLimit(http.MethodPost, "/plugins/sample-tally/check-now", plugin.AccessManager, plugin.RateLimitOperations,
		func(w http.ResponseWriter, _ *http.Request) error {
			plugin.WriteData(w, http.StatusOK, map[string]any{"polled": true})
			return nil
		})
}

// The plugin route host adapts once: the same frozen access levels operate
// over a bearer user principal with no plugin implementation change. A read
// grant reads viewer and session routes without CSRF; a write grant is
// refused the manager route by scope; an admin grant reaches the plugin's
// own logic exactly like the session did.
func TestPluginRoutesBearerParity(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := t.Context()
		authService := auth.NewService(env.pool, time.Hour)
		oauthService := oauth.NewService(env.pool)
		env.server.auth = authService
		env.server.oauth = oauthService
		env.server.operationsLimiter = newRateLimiter(60, time.Minute)
		env.server.authLimiter = newRateLimiter(10, 10*time.Minute)
		env.server.cookieName = "tilecast_session"
		env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithPlugins(sampleplugin.New()))
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		hash, err := auth.HashPassword("correct horse battery staple")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,'owner',TRUE)`,
			uuid.New(), "Owner", "plugin-bearer-owner", hash); err != nil {
			t.Fatal(err)
		}
		result, err := authService.Login(ctx, auth.LoginInput{Username: "plugin-bearer-owner", Password: "correct horse battery staple"}, auth.MFAPolicyNone)
		if err != nil || result.Session == nil {
			t.Fatalf("login: %v", err)
		}
		ownerID := result.Session.User.ID
		pat := func(name string, scopes []string) string {
			secret, _, err := oauthService.CreatePAT(ctx, ownerID, name, scopes, 30)
			if err != nil {
				t.Fatal(err)
			}
			return secret
		}
		readPAT, writePAT, adminPAT := pat("plugin-r", []string{"read"}), pat("plugin-w", []string{"read", "write"}), pat("plugin-a", []string{"read", "write", "admin"})
		bearer := func(method, path, secret, body string) (int, map[string]any) {
			t.Helper()
			request, _ := http.NewRequest(method, router.URL+path, strings.NewReader(body))
			request.Header.Set("Authorization", "Bearer "+secret)
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

		if status, _ := bearer(http.MethodGet, "/api/v1/plugins/sample-tally/items", readPAT, ""); status != http.StatusOK {
			t.Fatalf("bearer viewer read = %d", status)
		}
		if status, body := bearer(http.MethodGet, "/api/v1/plugins/sample-tally/whoami", readPAT, ""); status != http.StatusOK ||
			body["data"].(map[string]any)["role"] != "owner" ||
			body["data"].(map[string]any)["userId"] != ownerID.String() {
			t.Fatalf("bearer whoami = %d %v", status, body)
		}
		if status, body := bearer(http.MethodPost, "/api/v1/plugins/sample-tally/items", writePAT, `{"label":"x"}`); status != http.StatusForbidden || code(body) != "insufficient_scope" {
			t.Fatalf("write grant manager route = %d %v", status, body)
		}
		// The admin grant reaches the plugin's own conflict, the same
		// answer the session got: no plugin code changed.
		if status, body := bearer(http.MethodPost, "/api/v1/plugins/sample-tally/items", adminPAT, `{"label":"x"}`); status != http.StatusConflict || code(body) != "plugin_not_installed" {
			t.Fatalf("admin grant manager route = %d %v", status, body)
		}
	})
}
