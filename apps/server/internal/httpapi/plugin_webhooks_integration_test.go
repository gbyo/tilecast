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
	"github.com/tilecast/tilecast/apps/server/pluginharness/webhookplugins"
)

// TestPluginWebhookRoutes drives the public webhook endpoint and the Studio
// token routes through the production router: the endpoint takes no
// session, answers POST only, never caches, and echoes a handshake as
// text/plain; a viewer reads webhook state, and only plugins.manage creates
// or revokes a token, whose secret appears once.
func TestPluginWebhookRoutes(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		authService := auth.NewService(env.pool, time.Hour)
		env.server.auth = authService
		env.server.cookieName = "tilecast_session"
		env.server.webhookLimiter = newRateLimiter(webhookAddressLimit, webhookAddressWindow)
		env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithPlugins(webhookplugins.New()), plugins.WithPublicURL("https://signage.example"))
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		sessions := map[string]auth.Session{}
		var ownerID uuid.UUID
		for _, role := range []string{"owner", "viewer"} {
			hash, err := auth.HashPassword("correct horse battery staple")
			if err != nil {
				t.Fatal(err)
			}
			id := uuid.New()
			if role == "owner" {
				ownerID = id
			}
			if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,$5,TRUE)`,
				id, role, "hooks-"+role, hash, role); err != nil {
				t.Fatal(err)
			}
			result, err := authService.Login(ctx, auth.LoginInput{Username: "hooks-" + role, Password: "correct horse battery staple"}, auth.MFAPolicyNone)
			if err != nil || result.Session == nil {
				t.Fatalf("login %s: %v", role, err)
			}
			sessions[role] = *result.Session
		}
		if _, _, err := env.server.plugins.Install(ctx, webhookplugins.ID, ownerID); err != nil {
			t.Fatal(err)
		}
		studio := func(role, method, path, body string) (int, string) {
			t.Helper()
			request, err := http.NewRequest(method, router.URL+path, strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			session := sessions[role]
			request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: session.Token})
			request.Header.Set("X-CSRF-Token", session.CSRFToken)
			request.Header.Set("Content-Type", "application/json")
			response, err := router.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			raw, _ := io.ReadAll(response.Body)
			return response.StatusCode, string(raw)
		}
		hook := func(method, path string, header http.Header, body string) *http.Response {
			t.Helper()
			request, err := http.NewRequest(method, router.URL+path, strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			for name, values := range header {
				request.Header[name] = values
			}
			response, err := router.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			return response
		}
		base := "/api/v1/plugins/" + webhookplugins.ID

		// Token lifecycle through Studio routes.
		if status, _ := studio("viewer", http.MethodPost, base+"/webhooks/doors/tokens", `{"name":"Panel"}`); status != http.StatusForbidden {
			t.Fatalf("viewer created a token: %d", status)
		}
		status, body := studio("owner", http.MethodPost, base+"/webhooks/doors/tokens", `{"name":"Panel"}`)
		if status != http.StatusCreated {
			t.Fatalf("create = %d %s", status, body)
		}
		var created struct {
			Data plugins.CreatedWebhookToken `json:"data"`
		}
		if err := json.Unmarshal([]byte(body), &created); err != nil || !strings.HasPrefix(created.Data.Token, "tch_") {
			t.Fatalf("created %s", body)
		}
		status, body = studio("viewer", http.MethodGet, base+"/webhooks", "")
		secret := created.Data.Token[strings.LastIndex(created.Data.Token, ".")+1:]
		if status != http.StatusOK || strings.Contains(body, secret) || !strings.Contains(body, created.Data.PublicID) ||
			!strings.Contains(body, `"endpointUrl":"https://signage.example/api/v1/hooks/harness_hooks/doors"`) {
			t.Fatalf("list = %d %s", status, body)
		}

		// The public endpoint: no session, POST only, no-store.
		accepted := hook(http.MethodPost, "/api/v1/hooks/harness_hooks/doors", http.Header{
			"Authorization": {"Bearer " + created.Data.Token}, "X-Event-Id": {"e1"}}, `{"door":"north"}`)
		accepted.Body.Close()
		if accepted.StatusCode != http.StatusAccepted || accepted.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("accepted = %d %v", accepted.StatusCode, accepted.Header)
		}
		get := hook(http.MethodGet, "/api/v1/hooks/harness_hooks/doors", nil, "")
		get.Body.Close()
		if get.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("GET = %d", get.StatusCode)
		}
		denied := hook(http.MethodPost, "/api/v1/hooks/harness_hooks/doors", http.Header{"X-Event-Id": {"e2"}}, `{}`)
		raw, _ := io.ReadAll(denied.Body)
		denied.Body.Close()
		if denied.StatusCode != http.StatusUnauthorized || !strings.Contains(string(raw), `"code":"unauthenticated"`) {
			t.Fatalf("unauthenticated = %d %s", denied.StatusCode, raw)
		}

		// A handshake is text/plain and nosniff.
		handshake := hook(http.MethodPost, "/api/v1/hooks/harness_hooks/graph?validationToken=hello%20%3Cworld%3E", nil, "")
		raw, _ = io.ReadAll(handshake.Body)
		handshake.Body.Close()
		if handshake.StatusCode != http.StatusOK || string(raw) != "hello <world>" ||
			handshake.Header.Get("Content-Type") != "text/plain; charset=utf-8" || handshake.Header.Get("X-Content-Type-Options") != "nosniff" ||
			handshake.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("handshake = %d %q %v", handshake.StatusCode, raw, handshake.Header)
		}

		// Revocation.
		if status, _ := studio("viewer", http.MethodDelete, base+"/webhooks/doors/tokens/"+created.Data.ID.String(), ""); status != http.StatusForbidden {
			t.Fatalf("viewer revoked: %d", status)
		}
		if status, body := studio("owner", http.MethodDelete, base+"/webhooks/doors/tokens/"+created.Data.ID.String(), ""); status != http.StatusOK {
			t.Fatalf("revoke = %d %s", status, body)
		}
		again := hook(http.MethodPost, "/api/v1/hooks/harness_hooks/doors", http.Header{
			"Authorization": {"Bearer " + created.Data.Token}, "X-Event-Id": {"e3"}}, `{}`)
		again.Body.Close()
		if again.StatusCode != http.StatusUnauthorized {
			t.Fatalf("revoked token = %d", again.StatusCode)
		}
		if status, _ := studio("owner", http.MethodPost, base+"/webhooks/changes/tokens", `{"name":"x"}`); status != http.StatusConflict {
			t.Fatalf("token for a signature webhook = %d", status)
		}
	})
}
