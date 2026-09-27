package cli

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
)

// The MCP tests below prove the same boundary the CLI dispatcher
// proves: the "gizmo" plugin exists only in the fixture mux, and its
// tool family appears with no production code naming it.

func mcpFixture(t *testing.T) (*cliFixture, *mcpBackend) {
	t.Helper()
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TILECAST_TOKEN", "tcp_mcp")
	root := NewRootCommandWithEnv(f.env)
	resolved, err := f.env.resolver(root).Resolve(true)
	if err != nil {
		t.Fatal(err)
	}
	transport, err := f.env.newTransport(resolved)
	if err != nil {
		t.Fatal(err)
	}
	return f, &mcpBackend{transport: transport}
}

func jsonString(value any) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

func TestMCPBackendReads(t *testing.T) {
	_, backend := mcpFixture(t)
	ctx := context.Background()
	screens, err := backend.screenList(ctx, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	list, ok := screens.([]screenRecord)
	if !ok || len(list) == 0 {
		t.Fatalf("screen_list = %#v", screens)
	}
	screen, err := backend.screenGet(ctx, map[string]any{"idOrName": "lobby"})
	if err != nil {
		t.Fatal(err)
	}
	if record, ok := screen.(screenRecord); !ok || record["name"] != "lobby" {
		t.Fatalf("screen_get = %#v", screen)
	}
	if _, err := backend.screenGet(ctx, map[string]any{}); err == nil {
		t.Fatal("screen_get without id accepted")
	}
	session, err := backend.pairingResolve(ctx, map[string]any{"code": "ABC123"})
	if err != nil {
		t.Fatal(err)
	}
	if record, ok := session.(pairingRecord); !ok || record["id"] != "44444444-4444-4444-4444-444444444444" {
		t.Fatalf("pairing_resolve = %#v", session)
	}
	created, err := backend.scheduleCreate(ctx, map[string]any{"document": map[string]any{"name": "Nights"}})
	if err != nil {
		t.Fatal(err)
	}
	if record, ok := created.(scheduleRecord); !ok || record["name"] != "Nights" {
		t.Fatalf("schedule_create = %#v", created)
	}
}

func TestMCPConfirmGate(t *testing.T) {
	_, backend := mcpFixture(t)
	defs := coreMCPTools()
	byName := map[string]mcpToolDef{}
	for _, def := range defs {
		byName[def.name] = def
	}
	if !byName["screen_revoke"].needsConfirm() || !byName["token_create"].needsConfirm() || !byName["playlist_publish"].needsConfirm() {
		t.Fatal("sensitive tools must need confirmation")
	}
	if byName["screen_list"].needsConfirm() || byName["settings_set"].needsConfirm() || byName["plugin_install"].needsConfirm() {
		t.Fatal("read and routine tools must not need confirmation")
	}
	tools := buildMCPTools(backend, nil, false)
	names := map[string]bool{}
	for _, tool := range tools {
		names[tool.Tool.Name] = true
	}
	for _, want := range []string{"screen_list", "screen_revoke", "token_create", "activity_compliance"} {
		if !names[want] {
			t.Fatalf("missing tool %s", want)
		}
	}
}

func TestMCPReadOnly(t *testing.T) {
	_, backend := mcpFixture(t)
	tools := buildMCPTools(backend, nil, true)
	for _, tool := range tools {
		for _, banned := range []string{"screen_revoke", "settings_set", "token_create", "schedule_create", "playlist_publish", "plugin_install", "pairing_approve"} {
			if tool.Tool.Name == banned {
				t.Fatalf("read-only registers %s", banned)
			}
		}
	}
	found := false
	for _, tool := range tools {
		if tool.Tool.Name == "screen_list" {
			found = true
		}
	}
	if !found {
		t.Fatal("read-only drops screen_list")
	}
}

func TestMCPPluginFamily(t *testing.T) {
	_, backend := mcpFixture(t)
	ctx := context.Background()
	documents, err := fetchAutomation(ctx, backend.transport)
	if err != nil {
		t.Fatal(err)
	}
	if len(documents) != 1 || documents[0].Plugin != "gizmo_plugin" {
		t.Fatalf("automation documents = %+v", documents)
	}
	tools := buildMCPTools(backend, documents, false)
	names := []string{}
	for _, tool := range tools {
		names = append(names, tool.Tool.Name)
	}
	for _, want := range []string{"gizmo_plugin_list_widgets", "gizmo_plugin_get_widget", "gizmo_plugin_create_widget", "gizmo_plugin_delete_widget"} {
		found := false
		for _, name := range names {
			if name == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing plugin tool %s in %v", want, names)
		}
	}
	// The sensitive delete carries the confirm gate like core tools.
	defs := pluginMCPTools(documents)
	for _, def := range defs {
		if def.name == "gizmo_plugin_delete_widget" && !def.needsConfirm() {
			t.Fatal("sensitive plugin op skips confirmation")
		}
		if def.name == "gizmo_plugin_list_widgets" && def.needsConfirm() {
			t.Fatal("read plugin op demands confirmation")
		}
	}
	// End to end through the generic dispatcher: list and get.
	var listDef, getDef mcpToolDef
	for _, def := range defs {
		switch def.name {
		case "gizmo_plugin_list_widgets":
			listDef = def
		case "gizmo_plugin_get_widget":
			getDef = def
		}
	}
	listed, err := listDef.run(backend, ctx, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(jsonString(listed), "w-1") {
		t.Fatalf("plugin list = %v", listed)
	}
	got, err := getDef.run(backend, ctx, map[string]any{"name": "w-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(jsonString(got), "w-1") {
		t.Fatalf("plugin get = %v", got)
	}
	if _, err := getDef.run(backend, ctx, map[string]any{}); err == nil {
		t.Fatal("plugin get without path param accepted")
	}
}
