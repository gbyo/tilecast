package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
)

// The tests below prove the generic automation boundary: the "gizmo"
// plugin exists only in the fixture mux (auth_test.go). No production
// file in this package may name it; the boundary test enforces that.
// Every invocation below runs the production command tree, the same
// route the real binary serves.

func pluginFixture(t *testing.T) *cliFixture {
	t.Helper()
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TILECAST_TOKEN", "tcp_plugin")
	return f
}

func TestPluginListAndGet(t *testing.T) {
	f := pluginFixture(t)
	out, err := f.execute(t, "", "plugin", "list")
	if err != nil || !strings.Contains(out, "gizmo_plugin") || !strings.Contains(out, "dormant_plugin") {
		t.Fatalf("list = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "plugin", "list", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog map[string]any
	if err := json.Unmarshal([]byte(out), &catalog); err != nil {
		t.Fatalf("list --json is not JSON: %q", out)
	}
	items, _ := catalog["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("catalog items = %v", catalog)
	}
	out, err = f.execute(t, "", "plugin", "get", "gizmo_plugin")
	if err != nil || !strings.Contains(out, "Gizmo") {
		t.Fatalf("get = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "plugin", "get", "missing_plugin"); err == nil {
		t.Fatal("unknown plugin accepted")
	}
}

func TestPluginInstallAndRemove(t *testing.T) {
	f := pluginFixture(t)
	if _, err := f.execute(t, "", "plugin", "install", "dormant_plugin"); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("install without --yes accepted: %v", err)
	}
	out, err := f.execute(t, "", "plugin", "install", "dormant_plugin", "--yes")
	if err != nil || !strings.Contains(out, "installed dormant_plugin") {
		t.Fatalf("install = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "plugin", "install", "dormant_plugin", "--yes")
	if err != nil || !strings.Contains(out, "already installed") {
		t.Fatalf("reinstall = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "plugin", "remove", "gizmo_plugin"); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("remove without --yes accepted: %v", err)
	}
	out, err = f.execute(t, "", "plugin", "remove", "gizmo_plugin", "--yes")
	if err != nil || !strings.Contains(out, "removed gizmo_plugin") {
		t.Fatalf("remove = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "plugin", "install", "missing_plugin", "--yes"); err == nil {
		t.Fatal("install of unknown plugin accepted")
	}
}

func TestGenericAutomationDispatch(t *testing.T) {
	f := pluginFixture(t)
	out, err := f.execute(t, "", "plugin", "gizmo", "widget", "list")
	if err != nil || !strings.Contains(out, "w-1") || !strings.Contains(out, "w-2") {
		t.Fatalf("list = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "plugin", "gizmo", "widget", "get", "w-1")
	if err != nil || !strings.Contains(out, "w-1") {
		t.Fatalf("get = %q, %v", out, err)
	}
	if f.lastAutomationCall != "GET /api/v1/plugins/gizmo/widgets/w-1" {
		t.Fatalf("path substitution called %q", f.lastAutomationCall)
	}
	out, err = f.execute(t, "", "plugin", "gizmo", "widget", "create", "--input", `{"color":"red"}`)
	if err != nil || !strings.Contains(out, "w-3") {
		t.Fatalf("create = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "plugin", "gizmo", "widget", "get"); err == nil || !strings.Contains(err.Error(), "missing value") {
		t.Fatalf("missing path param accepted: %v", err)
	}
	if _, err := f.execute(t, "", "plugin", "gizmo", "widget", "create"); err == nil || !strings.Contains(err.Error(), "--input") {
		t.Fatalf("missing body accepted: %v", err)
	}
	if _, err := f.execute(t, "", "plugin", "gizmo", "widget", "list", "extra"); err == nil || !strings.Contains(err.Error(), "unexpected argument") {
		t.Fatalf("extra arg accepted: %v", err)
	}
}

func TestGenericAutomationConfirmation(t *testing.T) {
	f := pluginFixture(t)
	if _, err := f.execute(t, "", "plugin", "gizmo", "widget", "delete", "w-1", "--yes"); err != nil {
		t.Fatalf("delete --yes = %v", err)
	}
	if f.lastAutomationCall != "DELETE /api/v1/plugins/gizmo/widgets/w-1" {
		t.Fatalf("delete called %q", f.lastAutomationCall)
	}
	if _, err := f.execute(t, "", "plugin", "gizmo", "widget", "delete", "w-1"); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("sensitive delete without --yes accepted: %v", err)
	}
	out, err := f.execute(t, "y\n", "plugin", "gizmo", "widget", "delete", "w-1")
	if err != nil {
		t.Fatalf("delete with TTY confirmation = %q, %v", out, err)
	}
}

func TestGenericAutomationUnknownRoot(t *testing.T) {
	f := pluginFixture(t)
	if _, err := f.execute(t, "", "plugin", "frobnicate", "widget", "list"); err == nil || !strings.Contains(err.Error(), "plugin list") {
		t.Fatalf("unknown root accepted: %v", err)
	}
}

func TestPluginDynamicGlobalFlags(t *testing.T) {
	// Global flags work before and after the dynamic path, and through
	// the environment: dispatch never depends on args[0].
	for _, args := range [][]string{
		{"--context", "home", "plugin", "gizmo", "widget", "list"},
		{"plugin", "gizmo", "widget", "list", "--context", "home"},
		{"plugin", "gizmo", "widget", "get", "w-1", "--context=home"},
	} {
		f := pluginFixture(t)
		out, err := f.execute(t, "", args...)
		if err != nil || !strings.Contains(out, "w-1") {
			t.Fatalf("%v = %q, %v", args, out, err)
		}
	}
	f := pluginFixture(t)
	t.Setenv("TILECAST_CONTEXT", "home")
	out, err := f.execute(t, "", "plugin", "gizmo", "widget", "list")
	if err != nil || !strings.Contains(out, "w-1") {
		t.Fatalf("env context = %q, %v", out, err)
	}
}

func TestPluginDynamicQueryFlags(t *testing.T) {
	f := pluginFixture(t)
	out, err := f.execute(t, "", "plugin", "gizmo", "widget", "list", "--search", "lounge", "--limit", "5")
	if err != nil || !strings.Contains(out, "w-1") {
		t.Fatalf("query list = %q, %v", out, err)
	}
	if !strings.Contains(f.lastAutomationCall, "search=lounge") || !strings.Contains(f.lastAutomationCall, "limit=5") {
		t.Fatalf("query not sent: %q", f.lastAutomationCall)
	}
	if _, err := f.execute(t, "", "plugin", "gizmo", "widget", "list", "--bogus", "x"); err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Fatalf("unknown query flag accepted: %v", err)
	}
	if _, err := f.execute(t, "", "plugin", "gizmo", "widget", "reset", "--input", `{}`); err == nil || !strings.Contains(err.Error(), "field inputs") {
		t.Fatalf("fields input accepted: %v", err)
	}
}

func TestPluginDynamicPathEscaping(t *testing.T) {
	f := pluginFixture(t)
	out, err := f.execute(t, "", "plugin", "gizmo", "widget", "get", "a/b c?d#e%fünï")
	if err != nil {
		t.Fatalf("escaped get = %v", err)
	}
	_ = out
	want := "GET /api/v1/plugins/gizmo/widgets/a%2Fb%20c%3Fd%23e%25f%C3%BCn%C3%AF"
	if f.lastAutomationCall != want {
		t.Fatalf("escaped call = %q, want %q", f.lastAutomationCall, want)
	}
}

func TestAutomationPathHelpers(t *testing.T) {
	path, err := fillAutomationPath("/api/v1/plugins/gizmo/widgets/{name}/state/{mode}", []string{"w-1", "on"})
	if err != nil || path != "/api/v1/plugins/gizmo/widgets/w-1/state/on" {
		t.Fatalf("fill = %q, %v", path, err)
	}
	escaped, err := fillAutomationPath("/api/v1/plugins/gizmo/widgets/{name}", []string{"a b/c?d#e%fünï"})
	if err != nil || escaped != "/api/v1/plugins/gizmo/widgets/a%20b%2Fc%3Fd%23e%25f%C3%BCn%C3%AF" {
		t.Fatalf("escape = %q, %v", escaped, err)
	}
	// The rest of the path is never double-escaped.
	plain, err := fillAutomationPath("/api/v1/plugins/gizmo/widgets/{name}", []string{"w-1"})
	if err != nil || plain != "/api/v1/plugins/gizmo/widgets/w-1" {
		t.Fatalf("plain = %q, %v", plain, err)
	}
	if _, err := fillAutomationPath("/a/{x}", nil); err == nil {
		t.Fatal("missing param accepted")
	}
	if _, err := fillAutomationPath("/a", []string{"x"}); err == nil {
		t.Fatal("extra arg accepted")
	}
	if _, err := automationMethod("subscribe"); err == nil {
		t.Fatal("bad method accepted")
	}
}

func TestMatchDynamicOp(t *testing.T) {
	documents := []automationDoc{{
		APIVersion: 1,
		Plugin:     "example",
		Operations: []automationOp{
			{OperationID: "listThings", Method: "get", Path: "/api/v1/plugins/example/things", Risk: "read", CLIPath: []string{"example", "thing", "list"}, MCPAction: "list_things",
				QueryParams: []automationParam{{Name: "search", Type: "string"}, {Name: "exact", Required: true, Type: "boolean"}}},
			{OperationID: "getThing", Method: "get", Path: "/api/v1/plugins/example/things/{name}", Risk: "read", CLIPath: []string{"example", "thing", "get"}, MCPAction: "get_thing"},
		},
	}}
	operation, positionals, flags, err := matchDynamicOp(documents, []string{"example", "thing", "get", "w-1"})
	if err != nil || operation.OperationID != "getThing" || len(positionals) != 1 {
		t.Fatalf("match = %+v %v %v", operation, positionals, err)
	}
	// Boolean query flags accept a bare form; required queries enforce.
	operation, _, flags, err = matchDynamicOp(documents, []string{"example", "thing", "list", "--exact"})
	if err != nil || operation.OperationID != "listThings" || flags.query["exact"] != "true" {
		t.Fatalf("bool query = %+v %v %v", operation, flags, err)
	}
	if _, _, _, err := matchDynamicOp(documents, []string{"example", "thing", "list"}); err == nil || !strings.Contains(err.Error(), "missing required --exact") {
		t.Fatalf("required query accepted: %v", err)
	}
	// Flags split from positionals without a command tree.
	operation, _, flags, err = matchDynamicOp(documents, []string{"--search=lounge", "example", "thing", "list", "--exact=false"})
	if err != nil {
		t.Fatal(err)
	}
	if operation.OperationID != "listThings" || flags.query["search"] != "lounge" || flags.query["exact"] != "false" {
		t.Fatalf("split = %+v %v", operation, flags)
	}
	// The -- terminator keeps dashed values positional.
	operation, positionals, _, err = matchDynamicOp(documents, []string{"example", "thing", "get", "--", "--not-a-flag"})
	if err != nil {
		t.Fatal(err)
	}
	if operation.OperationID != "getThing" || len(positionals) != 1 || positionals[0] != "--not-a-flag" {
		t.Fatalf("terminator = %+v %v", operation, positionals)
	}
	if _, _, _, err := matchDynamicOp(documents, []string{"example", "thing", "list", "--exact", "true", "--bogus", "x"}); err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Fatalf("unknown flag accepted: %v", err)
	}
	if _, _, _, err := matchDynamicOp(documents, []string{"nope", "thing", "list"}); err == nil || !strings.Contains(err.Error(), "unknown plugin command") {
		t.Fatalf("unknown command accepted: %v", err)
	}
}
