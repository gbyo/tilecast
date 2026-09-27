package cli

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
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

// A child test process runs the real stdio server so the parent can verify
// protocol framing with the official MCP client.
func TestMCPStdioChild(t *testing.T) {
	if os.Getenv("TILECAST_MCP_TEST_CHILD") != "1" {
		return
	}
	root := NewRootCommand()
	args := []string{"mcp"}
	if os.Getenv("TILECAST_MCP_TEST_READ_ONLY") == "1" {
		args = append(args, "--read-only")
	}
	root.SetArgs(args)
	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

func TestMCPStdioProtocol(t *testing.T) {
	f := newFixture(t)
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.NewStore(configPath).Upsert(config.Context{
		Name: "probe", ServerURL: f.server.URL,
		InstallationID: "123e4567-e89b-12d3-a456-426614174000",
	}, true); err != nil {
		t.Fatal(err)
	}
	for _, readOnly := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		child := exec.Command(os.Args[0], "-test.run=^TestMCPStdioChild$")
		child.Env = append(os.Environ(), "TILECAST_MCP_TEST_CHILD=1", "TILECAST_CONFIG="+configPath,
			"TILECAST_URL="+f.server.URL, "TILECAST_TOKEN=tcp_mcp")
		if readOnly {
			child.Env = append(child.Env, "TILECAST_MCP_TEST_READ_ONLY=1")
		}
		client := mcp.NewClient("tilecast-probe", "1", nil)
		session, err := client.Connect(ctx, mcp.NewCommandTransport(child))
		if err != nil {
			cancel()
			t.Fatalf("stdio initialize (readOnly=%v): %v", readOnly, err)
		}
		listed, err := session.ListTools(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		names := map[string]bool{}
		for _, tool := range listed.Tools {
			names[tool.Name] = true
		}
		if !names["screen_list"] || !names["gizmo_plugin_list_widgets"] {
			t.Fatalf("stdio tools/list missing core or plugin read: %v", names)
		}
		if readOnly && (names["screen_revoke"] || names["gizmo_plugin_create_widget"]) {
			t.Fatalf("read-only exposed mutation: %v", names)
		}
		read, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "screen_list", Arguments: map[string]any{}})
		if err != nil || read.IsError {
			t.Fatalf("stdio screen_list: %+v, %v", read, err)
		}
		if !readOnly {
			refused, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "screen_revoke", Arguments: map[string]any{"idOrName": "lobby"}})
			if err == nil && (refused == nil || !refused.IsError) {
				t.Fatalf("unconfirmed sensitive call was not refused: %+v, %v", refused, err)
			}
			if err != nil && !strings.Contains(err.Error(), "confirm=true") {
				t.Fatalf("sensitive refusal was unclear: %v", err)
			}
			confirmed, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "screen_revoke", Arguments: map[string]any{"idOrName": "lobby", "confirm": true}})
			if err != nil || confirmed.IsError {
				t.Fatalf("confirmed fixture revoke failed: %+v, %v", confirmed, err)
			}
		}
		if err := session.Close(); err != nil {
			t.Fatal(err)
		}
		cancel()
	}
}
