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
)

// TestPluginStoreAPI drives the normalized plugin store through the
// production router: every signed-in role can read it, unknown entries
// answer 404 plugin_not_found, and install state is reflected.
func TestPluginStoreAPI(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		authService := auth.NewService(env.pool, time.Hour)
		env.server.auth = authService
		env.server.cookieName = "tilecast_session"
		env.server.plugins = plugins.NewService(env.pool, nil)
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		sessions := map[string]auth.Session{}
		for _, role := range []string{"owner", "viewer"} {
			hash, err := auth.HashPassword("correct horse battery staple")
			if err != nil {
				t.Fatal(err)
			}
			username := "store-" + role
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
			request, err := http.NewRequest(method, router.URL+path, strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			session := sessions[role]
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

		// Every authenticated user can read the store.
		status, body := call("viewer", http.MethodGet, "/api/v1/plugin-store", false, "")
		if status != http.StatusOK {
			t.Fatalf("viewer store status = %d", status)
		}
		data := body["data"].(map[string]any)
		items := data["items"].([]any)
		if len(items) != 3 {
			t.Fatalf("store items = %d, want 3", len(items))
		}
		for _, raw := range items {
			entry := raw.(map[string]any)
			if entry["source"].(map[string]any)["kind"] != "included" {
				t.Fatalf("store entry %v has non-included source", entry["packageId"])
			}
			plugin := entry["plugin"].(map[string]any)
			if entry["packageId"] != plugin["id"] {
				t.Fatalf("store packageId %v != plugin id %v", entry["packageId"], plugin["id"])
			}
		}
		if _, ok := data["unsupportedInstallations"]; !ok {
			t.Fatal("store omits unsupportedInstallations")
		}

		// One entry, and an unknown one.
		if status, body = call("viewer", http.MethodGet, "/api/v1/plugin-store/countdown_bar", false, ""); status != http.StatusOK {
			t.Fatalf("viewer store entry status = %d", status)
		} else if body["data"].(map[string]any)["packageId"] != "countdown_bar" {
			t.Fatalf("store entry packageId = %v", body["data"])
		}
		status, body = call("viewer", http.MethodGet, "/api/v1/plugin-store/no_such_plugin", false, "")
		if status != http.StatusNotFound {
			t.Fatalf("unknown store entry status = %d, want 404", status)
		}
		if code := body["error"].(map[string]any)["code"]; code != "plugin_not_found" {
			t.Fatalf("unknown store entry code = %v, want plugin_not_found", code)
		}

		// Installing through the existing endpoint is reflected in the store.
		if status, _ = call("owner", http.MethodPost, "/api/v1/plugins/countdown_bar/install", true, ""); status != http.StatusCreated {
			t.Fatalf("install status = %d, want 201", status)
		}
		if status, body = call("viewer", http.MethodGet, "/api/v1/plugin-store/countdown_bar", false, ""); status != http.StatusOK {
			t.Fatalf("viewer store entry status = %d", status)
		} else if installed := body["data"].(map[string]any)["plugin"].(map[string]any)["installed"]; installed != true {
			t.Fatalf("store entry installed = %v after install", installed)
		}
	})
}
