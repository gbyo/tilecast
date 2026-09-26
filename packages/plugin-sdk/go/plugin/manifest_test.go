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
	}{{"valid", true}, {"invalid", false}} {
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
