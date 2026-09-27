package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
	"github.com/tilecast/tilecast/apps/cli/internal/secret"
)

type cliFixture struct {
	env                 *environment
	revoked             []string
	server              *httptest.Server
	lastAutomationCall  string
	lastScreenUpdate    map[string]any
	lastPairingApproval map[string]any
	lastPublishRevision int64
	lastIncidentQuery   string
}

func newFixture(t *testing.T) *cliFixture {
	t.Helper()
	f := &cliFixture{env: &environment{
		config:  config.NewStore(filepath.Join(t.TempDir(), "config.json")),
		secrets: secret.NewMemoryStore(),
	}}
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, data any) {
		raw, _ := json.Marshal(map[string]any{"data": data})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}
	mux.HandleFunc("/api/v1/system/identity", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"product": "tilecast", "installationId": "123e4567-e89b-12d3-a456-426614174000", "organizationName": "Test Org", "apiVersion": "v1"})
	})
	mux.HandleFunc("/api/v1/auth/status", func(w http.ResponseWriter, r *http.Request) {
		bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if bearer == "tca_a1" || bearer == "tca_a2" || strings.HasPrefix(bearer, "tcp_") {
			write(w, map[string]any{"setupRequired": false, "authenticated": true,
				"user": map[string]any{"username": "op", "name": "Op", "role": "owner"}, "authMethod": "oauth"})
			return
		}
		write(w, map[string]any{"setupRequired": false, "authenticated": false})
	})
	mux.HandleFunc("/api/v1/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch {
		case body["grant_type"] == "authorization_code" && strings.HasPrefix(body["code"], "code-"):
			write(w, map[string]any{"access_token": "tca_a1", "refresh_token": "tcr_r1", "token_type": "Bearer", "expires_at": time.Now().Add(time.Hour).UTC()})
		case body["grant_type"] == "refresh_token" && body["refresh_token"] == "tcr_r1":
			write(w, map[string]any{"access_token": "tca_a2", "refresh_token": "tcr_r2", "token_type": "Bearer", "expires_at": time.Now().Add(time.Hour).UTC()})
		default:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"invalid_grant","message":"no"}}`))
		}
	})
	settingsRevision := 7
	settingsValues := map[string]any{"power.active_hours_end": "17:00"}
	mux.HandleFunc("/api/v1/screens", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"screens": []any{
			map[string]any{"id": "11111111-1111-1111-1111-111111111111", "name": "lobby", "status": "online"},
			map[string]any{"id": "22222222-2222-2222-2222-222222222222", "name": "hall", "status": "stale"},
			map[string]any{"id": "33333333-3333-3333-3333-333333333333", "name": "hall", "status": "offline"},
		}})
	})
	mux.HandleFunc("/api/v1/screens/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/v1/screens/")
		parts := strings.Split(rest, "/")
		if parts[0] == "pairing" {
			switch {
			case rest == "pairing/pending" && r.Method == http.MethodGet:
				write(w, map[string]any{"items": []any{
					map[string]any{"id": "44444444-4444-4444-4444-444444444444", "status": "pending", "expiresAt": "2030-01-01T00:00:00Z"},
				}, "total": 1})
				return
			case rest == "pairing/resolve" && r.Method == http.MethodPost:
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["code"] == "ABC123" {
					write(w, map[string]any{"id": "44444444-4444-4444-4444-444444444444", "status": "pending", "expiresAt": "2030-01-01T00:00:00Z"})
					return
				}
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":{"code":"pairing_not_found","message":"no"}}`))
				return
			case len(parts) == 3 && parts[2] == "approve" && r.Method == http.MethodPost:
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				f.lastPairingApproval = body
				write(w, map[string]any{"id": "55555555-5555-5555-5555-555555555555", "name": body["name"], "status": "online"})
				return
			case len(parts) == 3 && parts[2] == "reject" && r.Method == http.MethodPost:
				f.lastAutomationCall = "REJECT " + parts[1]
				w.WriteHeader(http.StatusNoContent)
				return
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"no"}}`))
			return
		}
		if len(parts) == 2 && r.Method == http.MethodPost {
			switch parts[1] {
			case "disable", "enable", "revoke":
				f.lastAutomationCall = "POST " + r.URL.Path
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if len(parts) == 1 {
			switch parts[0] {
			case "11111111-1111-1111-1111-111111111111":
				if r.Method == http.MethodPatch {
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					f.lastScreenUpdate = body
					body["id"] = parts[0]
					body["status"] = "online"
					write(w, body)
					return
				}
				write(w, map[string]any{"id": parts[0], "name": "lobby", "status": "online",
					"roomName": "Foyer", "roomNumber": "1A", "description": "Front lobby screen"})
				return
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"no"}}`))
			return
		}
		if len(parts) == 2 && parts[1] == "effective-policy" && parts[0] == "11111111-1111-1111-1111-111111111111" {
			write(w, map[string]any{"screenId": parts[0], "policy": map[string]any{"mode": "scheduled"}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"no"}}`))
	})
	mux.HandleFunc("/api/v1/settings", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			write(w, map[string]any{"revision": settingsRevision, "values": settingsValues})
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		revision, _ := body["revision"].(float64)
		if int(revision) != settingsRevision {
			w.WriteHeader(http.StatusConflict)
			raw, _ := json.Marshal(map[string]any{"error": map[string]any{"code": "revision_conflict", "message": "stale"},
				"data": map[string]any{"expectedRevision": revision, "currentRevision": settingsRevision}})
			_, _ = w.Write(raw)
			return
		}
		if values, ok := body["values"].(map[string]any); ok {
			for k, v := range values {
				settingsValues[k] = v
			}
		}
		settingsRevision++
		write(w, map[string]any{"revision": settingsRevision, "values": settingsValues})
	})
	mux.HandleFunc("/api/v1/oauth/revoke", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.revoked = append(f.revoked, body["token"])
		w.WriteHeader(http.StatusNoContent)
	})
	// Synthetic plugin surface. "gizmo" exists only in this fixture: no
	// production code names it, so these routes prove the generic
	// dispatcher works from server data alone.
	gizmoInstalled := true
	dormantInstalled := false
	pluginEntry := func(id, name string, installed bool) map[string]any {
		return map[string]any{"id": id, "name": name, "version": 1, "description": name,
			"category": "Display", "icon": "box", "managementPath": "/plugins/" + id,
			"instanceNounSingular": "widget", "instanceNounPlural": "widgets",
			"requirements": []any{}, "capabilities": []any{},
			"installed": installed, "installable": true, "configured": installed,
			"active": installed, "instanceCount": 0, "attention": []any{}}
	}
	mux.HandleFunc("/api/v1/plugins", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"items": []any{
			pluginEntry("gizmo_plugin", "Gizmo", gizmoInstalled),
			pluginEntry("dormant_plugin", "Dormant", dormantInstalled),
		}, "unsupportedInstallations": []any{}})
	})
	automationDoc := map[string]any{"apiVersion": 1, "plugin": "gizmo_plugin",
		"operations": []any{
			map[string]any{"operationId": "listGizmoWidgets", "method": "get",
				"path": "/api/v1/plugins/gizmo/widgets", "risk": "read",
				"cliPath": []any{"gizmo", "widget", "list"}, "mcpAction": "list_widgets",
				"description": "List gizmo widgets."},
			map[string]any{"operationId": "getGizmoWidget", "method": "get",
				"path": "/api/v1/plugins/gizmo/widgets/{name}", "risk": "read",
				"cliPath": []any{"gizmo", "widget", "get"}, "mcpAction": "get_widget",
				"description": "Show one gizmo widget."},
			map[string]any{"operationId": "createGizmoWidget", "method": "post",
				"path": "/api/v1/plugins/gizmo/widgets", "risk": "routine", "input": "document",
				"cliPath": []any{"gizmo", "widget", "create"}, "mcpAction": "create_widget",
				"description": "Create a gizmo widget from a JSON document."},
			map[string]any{"operationId": "deleteGizmoWidget", "method": "delete",
				"path": "/api/v1/plugins/gizmo/widgets/{name}", "risk": "sensitive",
				"cliPath": []any{"gizmo", "widget", "delete"}, "mcpAction": "delete_widget",
				"description": "Delete a gizmo widget."},
		}, "exclusions": []any{}}
	mux.HandleFunc("/api/v1/plugins/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/v1/plugins/")
		parts := strings.Split(rest, "/")
		switch {
		case len(parts) == 2 && parts[1] == "automation" && r.Method == http.MethodGet:
			switch parts[0] {
			case "gizmo_plugin":
				if !gizmoInstalled {
					w.WriteHeader(http.StatusConflict)
					_, _ = w.Write([]byte(`{"error":{"code":"plugin_not_installed","message":"no"}}`))
					return
				}
				write(w, automationDoc)
				return
			case "dormant_plugin":
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"error":{"code":"plugin_not_installed","message":"no"}}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"plugin_not_found","message":"no"}}`))
			return
		case len(parts) == 2 && parts[1] == "install" && r.Method == http.MethodPost:
			switch parts[0] {
			case "dormant_plugin":
				if dormantInstalled {
					write(w, pluginEntry("dormant_plugin", "Dormant", true))
					return
				}
				dormantInstalled = true
				w.WriteHeader(http.StatusCreated)
				write(w, pluginEntry("dormant_plugin", "Dormant", true))
				return
			case "gizmo_plugin":
				write(w, pluginEntry("gizmo_plugin", "Gizmo", true))
				return
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"plugin_not_found","message":"no"}}`))
			return
		case len(parts) == 2 && parts[1] == "installation" && r.Method == http.MethodDelete:
			if parts[0] == "gizmo_plugin" {
				gizmoInstalled = false
				w.WriteHeader(http.StatusNoContent)
				return
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"plugin_not_found","message":"no"}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"no"}}`))
	})
	mux.HandleFunc("/api/v1/plugins/gizmo/widgets", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			write(w, map[string]any{"widgets": []any{
				map[string]any{"name": "w-1"}, map[string]any{"name": "w-2"}}})
			return
		}
		if r.Method == http.MethodPost {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			body["name"] = "w-3"
			w.WriteHeader(http.StatusCreated)
			write(w, body)
			return
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	playlistDraft := map[string]any{"id": "66666666-6666-6666-6666-666666666666", "name": "Morning",
		"draftRevision": float64(9), "hasUnpublishedChanges": true,
		"items": []any{map[string]any{"kind": "media"}}}
	mux.HandleFunc("/api/v1/playlists", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"items": []any{
			map[string]any{"id": "66666666-6666-6666-6666-666666666666", "name": "Morning", "hasUnpublishedChanges": true},
		}, "total": 1, "page": 1, "pageSize": 50})
	})
	mux.HandleFunc("/api/v1/playlists/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/v1/playlists/")
		if rest == "66666666-6666-6666-6666-666666666666" && r.Method == http.MethodGet {
			write(w, playlistDraft)
			return
		}
		if rest == "66666666-6666-6666-6666-666666666666/publish" && r.Method == http.MethodPost {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			revision, _ := body["expectedDraftRevision"].(float64)
			f.lastPublishRevision = int64(revision)
			if int64(revision) != 9 {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"error":{"code":"revision_conflict","message":"stale"}}`))
				return
			}
			write(w, map[string]any{"published": true, "revision": 10})
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"no"}}`))
	})
	mux.HandleFunc("/api/v1/schedules", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			write(w, map[string]any{"items": []any{
				map[string]any{"id": "77777777-7777-7777-7777-777777777777", "name": "Weekdays"},
			}, "total": 1})
			return
		}
		if r.Method == http.MethodPost {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if _, ok := body["name"]; !ok {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":{"code":"invalid_schedule","message":"no"}}`))
				return
			}
			w.WriteHeader(http.StatusCreated)
			write(w, map[string]any{"id": "88888888-8888-8888-8888-888888888888", "name": body["name"]})
			return
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	mux.HandleFunc("/api/v1/schedules/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/v1/schedules/")
		if rest == "77777777-7777-7777-7777-777777777777" && r.Method == http.MethodGet {
			write(w, map[string]any{"id": rest, "name": "Weekdays"})
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"schedule_not_found","message":"no"}}`))
	})
	mux.HandleFunc("/api/v1/me/security/pats", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			write(w, map[string]any{"pats": []any{
				map[string]any{"id": "99999999-9999-9999-9999-999999999999", "name": "ci",
					"scopes": []any{"read"}, "expiresAt": "2030-01-01T00:00:00Z"},
			}})
			return
		}
		if r.Method == http.MethodPost {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			name, _ := body["name"].(string)
			if name == "" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":{"code":"invalid_name","message":"no"}}`))
				return
			}
			w.WriteHeader(http.StatusCreated)
			write(w, map[string]any{"token": "tcp_created_secret",
				"pat": map[string]any{"id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": name,
					"scopes": body["scopes"], "expiresAt": "2030-01-01T00:00:00Z"}})
			return
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	mux.HandleFunc("/api/v1/activity/overview", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"cards": map[string]any{"screens": 3}, "range": map[string]any{"from": r.URL.Query().Get("from")}})
	})
	mux.HandleFunc("/api/v1/activity/uptime", func(w http.ResponseWriter, r *http.Request) {
		window := r.URL.Query().Get("window")
		if window == "" {
			window = "24h"
		}
		if window != "24h" && window != "7d" && window != "30d" {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"error":{"code":"uptime_window_invalid","message":"no"}}`))
			return
		}
		write(w, map[string]any{"window": window, "uptimePct": 99.5})
	})
	mux.HandleFunc("/api/v1/activity/incidents", func(w http.ResponseWriter, r *http.Request) {
		f.lastIncidentQuery = r.URL.RawQuery
		write(w, map[string]any{"items": []any{
			map[string]any{"id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "incidentType": "connectivity",
				"severity": "error", "status": "open", "title": "Lobby offline",
				"openedAt": "2030-01-02T00:00:00Z"},
			map[string]any{"id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "incidentType": "playback",
				"severity": "warning", "status": "acknowledged", "title": "Hall stalls",
				"openedAt": "2030-01-01T00:00:00Z"},
		}})
	})
	mux.HandleFunc("/api/v1/activity/incidents/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/v1/activity/incidents/")
		if rest == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" {
			write(w, map[string]any{"id": rest, "title": "Lobby offline", "status": "open", "severity": "error",
				"timeline": []any{map[string]any{"summary": "opened"}, map[string]any{"summary": "acked"}}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"incident_not_found","message":"no"}}`))
	})
	mux.HandleFunc("/api/v1/activity/compliance", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"expected": 100, "actual": 97})
	})
	mux.HandleFunc("/api/v1/plugins/gizmo/widgets/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/api/v1/plugins/gizmo/widgets/")
		f.lastAutomationCall = r.Method + " " + r.URL.Path
		switch r.Method {
		case http.MethodGet:
			write(w, map[string]any{"name": name})
			return
		case http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *cliFixture) execute(t *testing.T, stdin string, args ...string) (string, error) {
	t.Helper()
	root := NewRootCommandWithEnv(f.env)
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	if stdin != "" {
		root.SetIn(strings.NewReader(stdin))
	}
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

func TestContextCommands(t *testing.T) {
	f := newFixture(t)
	if out, err := f.execute(t, "", "context", "current"); err == nil || !strings.Contains(err.Error(), "no current context") {
		t.Fatalf("current empty = %q, %v", out, err)
	}
	for _, ctx := range []config.Context{
		{Name: "b", ServerURL: "https://b.example"},
		{Name: "a", ServerURL: "https://a.example"},
	} {
		if err := f.env.config.Upsert(ctx, false); err != nil {
			t.Fatal(err)
		}
	}
	out, err := f.execute(t, "", "context", "list")
	if err != nil || !strings.Contains(out, "a") || !strings.Contains(out, "b") {
		t.Fatalf("list = %q, %v", out, err)
	}
	if out, err := f.execute(t, "", "context", "use", "a"); err != nil || !strings.Contains(out, `"a"`) {
		t.Fatalf("use = %q, %v", out, err)
	}
	if out, err := f.execute(t, "", "context", "current"); err != nil || strings.TrimSpace(out) != "a" {
		t.Fatalf("current = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "context", "use", "missing"); err == nil {
		t.Fatal("use missing succeeded")
	}
	if out, err := f.execute(t, "", "context", "rename", "a", "home"); err != nil || !strings.Contains(out, `"home"`) {
		t.Fatalf("rename = %q, %v", out, err)
	}
	if out, err := f.execute(t, "", "context", "remove", "home"); err != nil {
		t.Fatalf("remove = %q, %v", out, err)
	}
	if out, err := f.execute(t, "", "context", "current"); err != nil || strings.TrimSpace(out) != "b" {
		t.Fatalf("current after remove = %q, %v", out, err)
	}
}

func TestWhoamiPrecedence(t *testing.T) {
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	// Explicit environment value is honored.
	t.Setenv("TILECAST_TOKEN", "tcp_env")
	out, err := f.execute(t, "", "whoami")
	if err != nil || !strings.Contains(out, "op (owner)") {
		t.Fatalf("env whoami = %q, %v", out, err)
	}
	// Environment beats the store (which is empty here).
	out, err = f.execute(t, "", "whoami")
	if err != nil || !strings.Contains(out, f.server.URL) {
		t.Fatalf("env whoami = %q, %v", out, err)
	}
	// Nothing anywhere fails with guidance, not a stack trace.
	t.Setenv("TILECAST_TOKEN", "")
	if _, err := f.execute(t, "", "whoami"); err == nil {
		t.Fatal("whoami without credential succeeded")
	}
}

func TestWhoamiRotatesStoredPair(t *testing.T) {
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	stale, _ := json.Marshal(storedCredential{Kind: credentialOAuth, AccessToken: "tca_old", RefreshToken: "tcr_r1", ExpiresAt: time.Now().Add(-time.Hour)})
	if err := f.env.secrets.Set(credentialAccount("home"), string(stale)); err != nil {
		t.Fatal(err)
	}
	out, err := f.execute(t, "", "whoami")
	if err != nil || !strings.Contains(out, "op (owner)") {
		t.Fatalf("rotating whoami = %q, %v", out, err)
	}
	stored, err := readStored(f.env, "home")
	if err != nil || stored.AccessToken != "tca_a2" || stored.RefreshToken != "tcr_r2" {
		t.Fatalf("pair not persisted: %+v, %v", stored, err)
	}
}

func TestTokenStdinLogin(t *testing.T) {
	f := newFixture(t)
	out, err := f.execute(t, "tcp_setup-token\n", "auth", "login", f.server.URL, "--token-stdin", "--context-name", "ci")
	if err != nil || !strings.Contains(out, `Context "ci" is current`) {
		t.Fatalf("stdin login = %q, %v", out, err)
	}
	stored, err := readStored(f.env, "ci")
	if err != nil || stored.Kind != credentialPAT || stored.AccessToken != "tcp_setup-token" {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
	current, err := f.env.config.Current()
	if err != nil || current.InstallationID != "123e4567-e89b-12d3-a456-426614174000" || current.ServerURL != f.server.URL {
		t.Fatalf("context = %+v, %v", current, err)
	}
	// Re-login under the same name against a different installation refuses.
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"product":"tilecast","installationId":"inst-2","organizationName":"Other","apiVersion":"v1"}}`))
	}))
	defer other.Close()
	if _, err := f.execute(t, "tcp_other\n", "auth", "login", other.URL, "--token-stdin", "--context-name", "ci"); err == nil {
		t.Fatal("installation change accepted")
	}
	// A non-PAT on stdin is refused before any network verification.
	if _, err := f.execute(t, "tca_oauth-token\n", "auth", "login", f.server.URL, "--token-stdin"); err == nil {
		t.Fatal("non-PAT stdin accepted")
	}
}

func TestBrowserLoginLoop(t *testing.T) {
	f := newFixture(t)
	previous := openBrowserFunc
	openBrowserFunc = func(approvalURL string) error {
		parsed, err := url.Parse(approvalURL)
		if err != nil {
			return err
		}
		query := parsed.Query()
		if query.Get("client_id") != "tilecast-cli" || query.Get("code_challenge_method") != "S256" || query.Get("scope") != "read write" {
			t.Errorf("approval URL = %q", approvalURL)
		}
		redirect, err := url.Parse(query.Get("redirect_uri"))
		if err != nil {
			return err
		}
		redirect.RawQuery = url.Values{"code": {"code-9"}, "state": {query.Get("state")}}.Encode()
		response, err := http.Get(redirect.String()) //nolint:gosec,noctx
		if err != nil {
			return err
		}
		response.Body.Close()
		return nil
	}
	t.Cleanup(func() { openBrowserFunc = previous })
	out, err := f.execute(t, "", "auth", "login", f.server.URL)
	if err != nil || !strings.Contains(out, "Signed in to Test Org") {
		t.Fatalf("browser login = %q, %v", out, err)
	}
	stored, err := readStored(f.env, "127.0.0.1")
	if err != nil || stored.Kind != credentialOAuth || stored.AccessToken != "tca_a1" {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
}

func TestAuthLogoutRevokesAndForgets(t *testing.T) {
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	pair, _ := json.Marshal(storedCredential{Kind: credentialOAuth, AccessToken: "tca_a1", RefreshToken: "tcr_r1", ExpiresAt: time.Now().Add(time.Hour)})
	if err := f.env.secrets.Set(credentialAccount("home"), string(pair)); err != nil {
		t.Fatal(err)
	}
	out, err := f.execute(t, "", "auth", "logout")
	if err != nil || !strings.Contains(out, "Logged out") {
		t.Fatalf("logout = %q, %v", out, err)
	}
	if len(f.revoked) != 1 || f.revoked[0] != "tcr_r1" {
		t.Fatalf("revoked = %v", f.revoked)
	}
	if _, err := readStored(f.env, "home"); err == nil {
		t.Fatal("credential survived logout")
	}
}

func TestAuthStatusStates(t *testing.T) {
	f := newFixture(t)
	if _, err := f.execute(t, "", "auth", "status"); err == nil {
		t.Fatal("status without context succeeded")
	}
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	out, err := f.execute(t, "", "auth", "status")
	if err != nil || !strings.Contains(out, "none (run") {
		t.Fatalf("status = %q, %v", out, err)
	}
	t.Setenv("TILECAST_TOKEN", "tcp_x")
	out, err = f.execute(t, "", "auth", "status")
	if err != nil || !strings.Contains(out, "explicit bearer") {
		t.Fatalf("env status = %q, %v", out, err)
	}
}

func TestLoginRefusesBadServers(t *testing.T) {
	f := newFixture(t)
	if _, err := f.execute(t, "", "auth", "login", "http://example.com"); err == nil {
		t.Fatal("public HTTP accepted")
	}
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"product":"other"}}`))
	}))
	defer foreign.Close()
	if _, err := f.execute(t, "", "auth", "login", foreign.URL); err == nil {
		t.Fatal("foreign product accepted")
	}
	if _, err := f.execute(t, "", "auth", "login", f.server.URL, "--scopes", "superuser"); err == nil {
		t.Fatal("bad scope accepted")
	}
}
