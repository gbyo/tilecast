package cli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
)

// The tests below prove the generic automation boundary: the "gizmo"
// plugin exists only in the fixture mux (auth_test.go). No production
// file in this package may name it; the boundary test enforces that.

func pluginFixture(t *testing.T) *cliFixture {
	t.Helper()
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TILECAST_TOKEN", "tcp_plugin")
	return f
}

func (f *cliFixture) executeDynamic(t *testing.T, stdin string, args ...string) (string, error) {
	t.Helper()
	root := NewRootCommandWithEnv(f.env)
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	if stdin != "" {
		root.SetIn(strings.NewReader(stdin))
	}
	err := Execute(root, f.env, args)
	return out.String(), err
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
	out, err := f.executeDynamic(t, "", "gizmo", "widget", "list")
	if err != nil || !strings.Contains(out, "w-1") || !strings.Contains(out, "w-2") {
		t.Fatalf("list = %q, %v", out, err)
	}
	out, err = f.executeDynamic(t, "", "gizmo", "widget", "get", "w-1")
	if err != nil || !strings.Contains(out, "w-1") {
		t.Fatalf("get = %q, %v", out, err)
	}
	if f.lastAutomationCall != "GET /api/v1/plugins/gizmo/widgets/w-1" {
		t.Fatalf("path substitution called %q", f.lastAutomationCall)
	}
	out, err = f.executeDynamic(t, "", "gizmo", "widget", "create", "--input", `{"color":"red"}`)
	if err != nil || !strings.Contains(out, "w-3") {
		t.Fatalf("create = %q, %v", out, err)
	}
	if _, err := f.executeDynamic(t, "", "gizmo", "widget", "get"); err == nil || !strings.Contains(err.Error(), "missing value") {
		t.Fatalf("missing path param accepted: %v", err)
	}
	if _, err := f.executeDynamic(t, "", "gizmo", "widget", "create"); err == nil || !strings.Contains(err.Error(), "--input") {
		t.Fatalf("missing body accepted: %v", err)
	}
	if _, err := f.executeDynamic(t, "", "gizmo", "widget", "list", "extra"); err == nil || !strings.Contains(err.Error(), "unexpected argument") {
		t.Fatalf("extra arg accepted: %v", err)
	}
}

func TestGenericAutomationConfirmation(t *testing.T) {
	f := pluginFixture(t)
	if _, err := f.executeDynamic(t, "", "gizmo", "widget", "delete", "w-1", "--yes"); err != nil {
		t.Fatalf("delete --yes = %v", err)
	}
	if f.lastAutomationCall != "DELETE /api/v1/plugins/gizmo/widgets/w-1" {
		t.Fatalf("delete called %q", f.lastAutomationCall)
	}
	if _, err := f.executeDynamic(t, "", "gizmo", "widget", "delete", "w-1"); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("sensitive delete without --yes accepted: %v", err)
	}
	out, err := f.executeDynamic(t, "y\n", "gizmo", "widget", "delete", "w-1")
	if err != nil {
		t.Fatalf("delete with TTY confirmation = %q, %v", out, err)
	}
}

func TestGenericAutomationUnknownRoot(t *testing.T) {
	f := pluginFixture(t)
	if _, err := f.executeDynamic(t, "", "frobnicate", "widget", "list"); err == nil || !strings.Contains(err.Error(), "plugin list") {
		t.Fatalf("unknown root accepted: %v", err)
	}
}

func TestAutomationPathHelpers(t *testing.T) {
	path, err := fillAutomationPath("/api/v1/plugins/gizmo/widgets/{name}/state/{mode}", []string{"w-1", "on"})
	if err != nil || path != "/api/v1/plugins/gizmo/widgets/w-1/state/on" {
		t.Fatalf("fill = %q, %v", path, err)
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
	scanned := preScanGlobals([]string{"gizmo", "--context", "prod", "widget", "--timeout=5s", "list"})
	if scanned["context"] != "prod" || scanned["timeout"] != "5s" {
		t.Fatalf("prescan = %v", scanned)
	}
}
