package plugin

import (
	"os"
	"path/filepath"
	"testing"
)

// The fixtures are shared with the Zod schema's tests, so the Go parser and
// the TypeScript schema agree on every case.
func TestManifestFixtures(t *testing.T) {
	for _, group := range []struct {
		dir   string
		valid bool
	}{{"valid", true}, {"invalid", false}, {"invalid-semantic", false}} {
		files, err := filepath.Glob(filepath.Join("..", "..", "testdata", "manifests", group.dir, "*.json"))
		if err != nil || len(files) == 0 {
			t.Fatalf("no %s fixtures: %v", group.dir, err)
		}
		for _, file := range files {
			t.Run(group.dir+"/"+filepath.Base(file), func(t *testing.T) {
				data, err := os.ReadFile(file)
				if err != nil {
					t.Fatal(err)
				}
				_, err = ParseManifest(data)
				if group.valid && err != nil {
					t.Fatalf("expected valid: %v", err)
				}
				if !group.valid && err == nil {
					t.Fatal("expected a validation error")
				}
			})
		}
	}
}

func TestManifestDefaults(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "manifests", "valid", "minimal.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := ParseManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	if !manifest.IsInstallable() || manifest.StudioRoute() != "" || manifest.ManifestTypes() != nil {
		t.Fatalf("unexpected defaults: %+v", manifest)
	}
}

// At the instance-kind limit the host still generates a bounded, distinct
// route surface: the settings routes plus five routes for each kind.
func TestGeneratedRoutesAtTheKindLimit(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "manifests", "valid", "v3-sixteen-kinds.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := ParseManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Instances) != MaxInstanceKinds || MaxInstanceKinds != 16 {
		t.Fatalf("kinds = %d, limit = %d", len(manifest.Instances), MaxInstanceKinds)
	}
	routes := GeneratedRoutes(manifest)
	seen := map[string]bool{}
	for _, route := range routes {
		key := route.Method + " " + route.Pattern
		if seen[key] {
			t.Fatalf("duplicate generated route %s", key)
		}
		seen[key] = true
	}
	// Two settings scopes with GET and PUT each, then five routes per kind.
	if len(routes) != 4+16*5 {
		t.Fatalf("generated routes = %d", len(routes))
	}
}
