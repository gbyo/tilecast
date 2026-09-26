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
		if status, body := call("viewer", http.MethodGet, "/api/v1/plugins/sample-tally/whoami", false, ""); status != http.StatusOK ||
			body["data"].(map[string]any)["role"] != "viewer" {
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
