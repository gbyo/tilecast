package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
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
