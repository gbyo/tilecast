package cli

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// forbiddenModulePrefixes are Go module paths the remote CLI must never
// link. The CLI talks to the Server over HTTP; Server internals,
// PostgreSQL code, and plugin implementations stay server-side.
var forbiddenModulePrefixes = []string{
	"github.com/tilecast/tilecast/apps/server/",
	"github.com/tilecast/tilecast/plugins",
}

// TestRemoteCLIDoesNotDependOnServerInternals enforces the Phase 2 module
// boundary with the compiled dependency graph, not with grep.
func TestRemoteCLIDoesNotDependOnServerInternals(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	moduleDir := filepath.Join(filepath.Dir(file), "..", "..")
	cmd := exec.Command("go", "list", "-deps", "./...")
	cmd.Dir = moduleDir
	raw, err := cmd.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			t.Fatalf("go list -deps: %v\n%s", err, exit.Stderr)
		}
		t.Fatalf("go list -deps: %v", err)
	}
	for _, dep := range strings.Fields(string(raw)) {
		for _, prefix := range forbiddenModulePrefixes {
			if dep == strings.TrimSuffix(prefix, "/") || strings.HasPrefix(dep, prefix) {
				t.Errorf("remote CLI depends on forbidden package %s", dep)
			}
		}
	}
}
