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

// TestPluginInstallationAPI drives install and remove through the production
// router so the session, role, and CSRF middleware are what is being tested.
func TestPluginInstallationAPI(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		authService := auth.NewService(env.pool, time.Hour)
		env.server.auth = authService
		env.server.cookieName = "tilecast_session"
		env.server.plugins = plugins.NewService(env.pool, nil)
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		sessions := map[string]auth.Session{}
		for _, role := range []string{"owner", "administrator", "editor", "viewer"} {
			hash, err := auth.HashPassword("correct horse battery staple")
			if err != nil {
				t.Fatal(err)
			}
			username := "plugins-" + role
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
		errorCode := func(body map[string]any) string {
			envelope, _ := body["error"].(map[string]any)
			code, _ := envelope["code"].(string)
			return code
		}

		// Every authenticated user can read the catalog.
		status, body := call("viewer", http.MethodGet, "/api/v1/plugins", false, "")
		if status != http.StatusOK {
			t.Fatalf("viewer catalog status = %d", status)
		}
		items := body["data"].(map[string]any)["items"].([]any)
		if len(items) != 3 {
			t.Fatalf("catalog items = %d, want 3", len(items))
		}

		for _, role := range []string{"viewer", "editor"} {
			if status, _ = call(role, http.MethodPost, "/api/v1/plugins/countdown_bar/install", true, ""); status != http.StatusForbidden {
				t.Fatalf("%s install status = %d, want 403", role, status)
			}
			if status, _ = call(role, http.MethodDelete, "/api/v1/plugins/countdown_bar/installation", true, ""); status != http.StatusForbidden {
				t.Fatalf("%s remove status = %d, want 403", role, status)
			}
		}
		if status, body = call("owner", http.MethodPost, "/api/v1/plugins/countdown_bar/install", false, ""); status != http.StatusForbidden || errorCode(body) != "csrf_failed" {
			t.Fatalf("install without CSRF = %d %v", status, body)
		}

		// Configuring before installing is refused rather than installing implicitly.
		bar := `{"name":"Lunch","message":"Lunch ends in","scheduleType":"weekly","targetTime":"12:00","daysOfWeek":[1,2,3,4,5],
			"timezone":"UTC","leadTimeSeconds":900,"completionText":"","showConfetti":false,"displayMode":"overlay","heightPx":72,
			"progressFill":"none","contentPadding":4,"textScale":100,"urgencyEnabled":false,"startingSoonSeconds":300,
			"urgentSeconds":60,"pulseSeconds":10,"enabled":true,"priority":0,"targetScope":"all","targetIds":[]}`
		if status, body = call("owner", http.MethodPost, "/api/v1/plugins/countdown-bar/instances", true, bar); status != http.StatusConflict || errorCode(body) != "plugin_not_installed" {
			t.Fatalf("configure uninstalled plugin = %d %v", status, body)
		}

		if status, body = call("administrator", http.MethodPost, "/api/v1/plugins/countdown_bar/install", true, ""); status != http.StatusCreated {
			t.Fatalf("first install = %d %v", status, body)
		}
		if installed, _ := body["data"].(map[string]any)["installed"].(bool); !installed {
			t.Fatalf("install response = %v", body)
		}
		if status, _ = call("owner", http.MethodPost, "/api/v1/plugins/countdown_bar/install", true, ""); status != http.StatusOK {
			t.Fatalf("repeat install = %d, want 200", status)
		}
		if status, body = call("owner", http.MethodPost, "/api/v1/plugins/not_a_plugin/install", true, ""); status != http.StatusNotFound || errorCode(body) != "plugin_not_found" {
			t.Fatalf("unknown install = %d %v", status, body)
		}

		if status, body = call("owner", http.MethodPost, "/api/v1/plugins/countdown-bar/instances", true, bar); status != http.StatusCreated {
			t.Fatalf("create bar after install = %d %v", status, body)
		}
		status, body = call("owner", http.MethodDelete, "/api/v1/plugins/countdown_bar/installation", true, "")
		if status != http.StatusConflict || errorCode(body) != "plugin_in_use" {
			t.Fatalf("remove in-use plugin = %d %v", status, body)
		}
		details := body["error"].(map[string]any)["details"].(map[string]any)
		resources := details["resources"].([]any)
		if details["pluginId"] != "countdown_bar" || len(resources) != 1 || resources[0].(map[string]any)["kind"] != "countdown_bar_instance" {
			t.Fatalf("plugin_in_use details = %v", details)
		}

		if status, _ = call("owner", http.MethodDelete, "/api/v1/plugins/forms/installation", true, ""); status != http.StatusNoContent {
			t.Fatalf("remove never-installed plugin = %d, want idempotent 204", status)
		}
		if status, _ = call("owner", http.MethodPost, "/api/v1/plugins/forms/install", true, ""); status != http.StatusCreated {
			t.Fatal("install forms")
		}
		if status, _ = call("administrator", http.MethodDelete, "/api/v1/plugins/forms/installation", true, ""); status != http.StatusNoContent {
			t.Fatalf("remove empty plugin = %d", status)
		}
		var removed int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action='plugin.removed' AND resource_id='forms'`).Scan(&removed); err != nil || removed != 1 {
			t.Fatalf("plugin.removed audits = %d (%v)", removed, err)
		}
	})
}
