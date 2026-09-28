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

// TestPluginAutomationAPI drives the automation document through the
// production router: unknown plugins, uninstalled plugins, and plugins
// with no automation mapping are refused before any document is served.
func TestPluginAutomationAPI(t *testing.T) {
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
			username := "automation-" + role
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

		call := func(role, path string) (int, map[string]any) {
			t.Helper()
			request, err := http.NewRequest(http.MethodGet, router.URL+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			if role != "" {
				session := sessions[role]
				request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
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
		install := func(id string) int {
			t.Helper()
			request, err := http.NewRequest(http.MethodPost, router.URL+"/api/v1/plugins/"+id+"/install", strings.NewReader(""))
			if err != nil {
				t.Fatal(err)
			}
			session := sessions["owner"]
			request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
			request.Header.Set("X-CSRF-Token", session.CSRFToken)
			response, err := router.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			_, _ = io.ReadAll(response.Body)
			return response.StatusCode
		}
		errorCode := func(body map[string]any) string {
			envelope, _ := body["error"].(map[string]any)
			code, _ := envelope["code"].(string)
			return code
		}

		if status, _ := call("", "/api/v1/plugins/countdown_bar/automation"); status != http.StatusUnauthorized {
			t.Fatalf("anonymous automation = %d, want 401", status)
		}
		if status, body := call("viewer", "/api/v1/plugins/not_a_plugin/automation"); status != http.StatusNotFound || errorCode(body) != "plugin_not_found" {
			t.Fatalf("unknown automation = %d %v", status, body)
		}
		if status, body := call("viewer", "/api/v1/plugins/countdown_bar/automation"); status != http.StatusConflict || errorCode(body) != "plugin_not_installed" {
			t.Fatalf("uninstalled automation = %d %v", status, body)
		}

		if status := install("forms"); status != http.StatusCreated {
			t.Fatalf("install forms = %d", status)
		}
		if status, body := call("viewer", "/api/v1/plugins/forms/automation"); status != http.StatusNotFound || errorCode(body) != "plugin_automation_not_found" {
			t.Fatalf("forms automation = %d %v", status, body)
		}

		if status := install("countdown_bar"); status != http.StatusCreated {
			t.Fatalf("install countdown_bar = %d", status)
		}
		status, body := call("viewer", "/api/v1/plugins/countdown_bar/automation")
		if status != http.StatusOK {
			t.Fatalf("automation status = %d %v", status, body)
		}
		document, _ := body["data"].(map[string]any)
		if document["plugin"] != "countdown_bar" || document["apiVersion"] != float64(1) {
			t.Fatalf("automation document = %v", document)
		}
		operations, _ := document["operations"].([]any)
		if len(operations) != 5 {
			t.Fatalf("automation operations = %d, want 5", len(operations))
		}
		first, _ := operations[0].(map[string]any)
		if first["operationId"] != "listCountdownBarInstances" || first["method"] != "get" {
			t.Fatalf("first operation = %v", first)
		}
		if cliPath, _ := first["cliPath"].([]any); len(cliPath) != 3 || cliPath[0] != "countdown-bar" {
			t.Fatalf("first cliPath = %v", cliPath)
		}
	})
}
