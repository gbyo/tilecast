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
	if record, ok := screen.(screenRecord); !ok || record.Name != "lobby" {
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

func TestMCPPairingApprovalMatchesServerContract(t *testing.T) {
	f, backend := mcpFixture(t)
	ctx := context.Background()

	defs := coreMCPTools()
	var pairing mcpToolDef
	for _, def := range defs {
		if def.name == "pairing_approve" {
			pairing = def
			break
		}
	}
	if pairing.name == "" {
		t.Fatal("pairing_approve tool missing")
	}
	required := map[string]bool{}
	for _, param := range pairing.params {
		required[param.name] = param.required
	}
	if !required["sessionId"] {
		t.Fatal("pairing_approve sessionId must stay required")
	}
	for _, optional := range []string{"name", "roomName", "roomNumber", "description"} {
		if required[optional] {
			t.Fatalf("pairing_approve %s should be conditionally/optionally supplied", optional)
		}
	}

	if _, err := backend.pairingApprove(ctx, map[string]any{
		"sessionId": "44444444-4444-4444-4444-444444444444",
		"name":      "Kiosk",
	}); err != nil {
		t.Fatalf("ordinary approval with optional room metadata omitted: %v", err)
	}
	if f.lastPairingApproval["roomName"] != "" || f.lastPairingApproval["roomNumber"] != "" ||
		f.lastPairingApproval["description"] != "" {
		t.Fatalf("ordinary approval body = %#v", f.lastPairingApproval)
	}

	if _, err := backend.pairingApprove(ctx, map[string]any{
		"sessionId":           "44444444-4444-4444-4444-444444444444",
		"replaceHardware":     true,
		"replacementScreenId": "11111111-1111-1111-1111-111111111111",
	}); err != nil {
		t.Fatalf("hardware replacement without screen metadata: %v", err)
	}
	if f.lastPairingApproval["replaceHardware"] != true ||
		f.lastPairingApproval["replacementScreenId"] != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("hardware replacement body = %#v", f.lastPairingApproval)
	}

	if _, err := backend.pairingApprove(ctx, map[string]any{
		"sessionId": "44444444-4444-4444-4444-444444444444",
	}); err == nil {
		t.Fatal("ordinary pairing without name accepted")
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

func TestMCPPluginSchemasAreTyped(t *testing.T) {
	_, backend := mcpFixture(t)
	ctx := context.Background()
	documents, err := fetchAutomation(ctx, backend.transport)
	if err != nil {
		t.Fatal(err)
	}
	tools := buildMCPTools(backend, documents, false)
	// Query parameters appear with their OpenAPI types and required
	// marks; the fixture list op declares an optional string search and
	// an optional integer limit.
	defs := pluginMCPTools(documents)
	var listDef *mcpToolDef
	for _, def := range defs {
		def := def
		if def.name == "gizmo_plugin_list_widgets" {
			listDef = &def
		}
	}
	if listDef == nil {
		t.Fatal("missing gizmo_plugin_list_widgets")
	}
	seen := map[string]mcpParam{}
	for _, param := range listDef.params {
		seen[param.name] = param
	}
	search, ok := seen["search"]
	if !ok || search.schemaType != "string" || search.required {
		t.Fatalf("search param = %+v, present %v", search, ok)
	}
	limit, ok := seen["limit"]
	if !ok || limit.schemaType != "integer" {
		t.Fatalf("limit param = %+v, present %v", limit, ok)
	}
	// The built input schema carries those types through.
	var listTool *mcp.ServerTool
	for _, tool := range tools {
		if tool.Tool.Name == "gizmo_plugin_list_widgets" {
			listTool = tool
		}
	}
	if listTool == nil {
		t.Fatal("missing built list tool")
	}
	searchSchema := listTool.Tool.InputSchema.Properties["search"]
	if searchSchema == nil || searchSchema.Type != "string" {
		t.Fatalf("search schema = %+v", searchSchema)
	}
	// The create op has no body metadata in this fixture document, so its
	// document parameter stays a free-form JSON value, still required.
	var createDef *mcpToolDef
	for _, def := range defs {
		def := def
		if def.name == "gizmo_plugin_create_widget" {
			createDef = &def
		}
	}
	if createDef == nil {
		t.Fatal("missing gizmo_plugin_create_widget")
	}
	foundDocument := false
	for _, param := range createDef.params {
		if param.name == "document" && param.required && param.schema == nil {
			foundDocument = true
		}
	}
	if !foundDocument {
		t.Fatalf("create params = %+v", createDef.params)
	}
}

func TestMCPPluginBodySchema(t *testing.T) {
	documents := []automationDoc{{
		APIVersion: 1,
		Plugin:     "example",
		Operations: []automationOp{{
			OperationID: "createThing", Method: "post", Path: "/api/v1/plugins/example/things",
			Risk: "routine", CLIPath: []string{"example", "thing", "create"}, MCPAction: "create_thing",
			Input: "document",
			RequestBody: &automationBody{Required: true, Schema: map[string]any{
				"type":     "object",
				"required": []any{"name"},
				"properties": map[string]any{
					"name":   map[string]any{"type": "string"},
					"count":  map[string]any{"type": "integer", "minimum": 1.0},
					"mode":   map[string]any{"type": "string", "enum": []any{"a", "b"}},
					"nested": map[string]any{"type": "object", "properties": map[string]any{"flag": map[string]any{"type": "boolean"}}},
				},
			}},
		}},
	}}
	defs := pluginMCPTools(documents)
	if len(defs) != 1 {
		t.Fatalf("defs = %+v", defs)
	}
	var document mcpParam
	for _, param := range defs[0].params {
		if param.name == "document" {
			document = param
		}
	}
	if document.schema == nil {
		t.Fatal("document schema missing")
	}
	properties := document.schema.Properties
	if properties["name"] == nil || properties["name"].Type != "string" {
		t.Fatalf("name schema = %+v", properties["name"])
	}
	if properties["count"] == nil || properties["count"].Type != "integer" || properties["count"].Minimum == nil {
		t.Fatalf("count schema = %+v", properties["count"])
	}
	if len(properties["mode"].Enum) != 2 {
		t.Fatalf("mode schema = %+v", properties["mode"])
	}
	if properties["nested"] == nil || properties["nested"].Properties["flag"] == nil || properties["nested"].Properties["flag"].Type != "boolean" {
		t.Fatalf("nested schema = %+v", properties["nested"])
	}
	if len(document.schema.Required) != 1 || document.schema.Required[0] != "name" {
		t.Fatalf("required = %v", document.schema.Required)
	}
}

func TestMCPPluginQueryAndEscaping(t *testing.T) {
	f, backend := mcpFixture(t)
	ctx := context.Background()
	documents, err := fetchAutomation(ctx, backend.transport)
	if err != nil {
		t.Fatal(err)
	}
	defs := pluginMCPTools(documents)
	byName := map[string]mcpToolDef{}
	for _, def := range defs {
		byName[def.name] = def
	}
	listed, err := byName["gizmo_plugin_list_widgets"].run(backend, ctx, map[string]any{"search": "lounge", "limit": float64(5)})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(jsonString(listed), "w-1") {
		t.Fatalf("plugin list = %v", listed)
	}
	if !strings.Contains(f.lastAutomationCall, "search=lounge") || !strings.Contains(f.lastAutomationCall, "limit=5") {
		t.Fatalf("query not sent: %q", f.lastAutomationCall)
	}
	got, err := byName["gizmo_plugin_get_widget"].run(backend, ctx, map[string]any{"name": "a/b c?d#e%f"})
	if err != nil {
		t.Fatal(err)
	}
	_ = got
	if f.lastAutomationCall != "GET /api/v1/plugins/gizmo/widgets/a%2Fb%20c%3Fd%23e%25f" {
		t.Fatalf("escaped call = %q", f.lastAutomationCall)
	}
}

// TestSyntheticPluginParity proves the architectural invariant in one
// place: a conforming plugin with an API and automation mapping gains
// CLI participation through the real binary path and MCP participation
// through tool listing, without handwritten source naming it.
func TestSyntheticPluginParity(t *testing.T) {
	f := pluginFixture(t)
	out, err := f.execute(t, "", "plugin", "gizmo", "widget", "list")
	if err != nil || !strings.Contains(out, "w-1") {
		t.Fatalf("CLI parity = %q, %v", out, err)
	}
	_, backend := mcpFixture(t)
	documents, err := fetchAutomation(context.Background(), backend.transport)
	if err != nil {
		t.Fatal(err)
	}
	tools := buildMCPTools(backend, documents, false)
	found := false
	for _, tool := range tools {
		if tool.Tool.Name == "gizmo_plugin_list_widgets" {
			found = true
		}
	}
	if !found {
		t.Fatal("MCP parity: gizmo family missing from tool listing")
	}
}
