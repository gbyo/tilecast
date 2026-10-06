package packagemanifest

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// The TypeScript suite runs these same fixtures, so the two validators
// cannot drift apart silently.
func fixturePaths(t *testing.T, group string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join("..", "..", "testdata", "manifests", group))
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".json" {
			paths = append(paths, filepath.Join("..", "..", "testdata", "manifests", group, entry.Name()))
		}
	}
	return paths
}

func TestParseAcceptsValidFixtures(t *testing.T) {
	for _, path := range fixturePaths(t, "valid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		manifest, err := Parse(data)
		if err != nil {
			t.Errorf("%s: Parse: %v", path, err)
			continue
		}
		if manifest.PackageID == "" || manifest.PackageVersion == "" {
			t.Errorf("%s: parsed manifest is missing identity", path)
		}
	}
}

func TestParseRejectsInvalidFixtures(t *testing.T) {
	for _, path := range fixturePaths(t, "invalid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Parse(data); err == nil {
			t.Errorf("%s: Parse succeeded, want an error", path)
		}
	}
}

func TestParseAcceptsOnePointZeroAPIVersion(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "manifests", "valid", "minimal.json"))
	if err != nil {
		t.Fatal(err)
	}
	// JSON has no integer type: 1.0 is the same document as 1, and the
	// TypeScript validator accepts both.
	patched := bytes.Replace(data, []byte(`"apiVersion": 1`), []byte(`"apiVersion": 1.0`), 1)
	if _, err := Parse(patched); err != nil {
		t.Fatalf("1.0 apiVersion: %v", err)
	}
}

func TestInNamespace(t *testing.T) {
	for _, tc := range []struct {
		contribution, packageID string
		want                    bool
	}{
		{"acme.athletics", "acme.athletics", true},
		{"acme.athletics.scoreboard", "acme.athletics", true},
		{"acme.other", "acme.athletics", false},
		{"acme.athletics2", "acme.athletics", false},
		{"other.athletics", "acme.athletics", false},
	} {
		if got := InNamespace(tc.contribution, tc.packageID); got != tc.want {
			t.Errorf("InNamespace(%q, %q) = %v, want %v", tc.contribution, tc.packageID, got, tc.want)
		}
	}
}

func TestSatisfiesTilecastRange(t *testing.T) {
	for _, tc := range []struct {
		versionRange, version string
		want                  bool
	}{
		{">=1.2.0 <2.0.0", "1.2.0", true},
		{">=1.2.0 <2.0.0", "1.9.4", true},
		{">=1.2.0 <2.0.0", "2.0.0", false},
		{">=1.2.0 <2.0.0", "1.1.9", false},
		{">=1.1", "1.1.0", true},
		{">=1.1", "1.0.9", false},
		{"=1.4.2", "1.4.2", true},
		{"=1.4.2", "1.4.3", false},
		{">2.0.0", "2.0.1", true},
		{">2.0.0", "2.0.0", false},
		{">=1.2.0 || <2.0.0", "1.5.0", false},
		{">=1.2.0", "one.two.three", false},
		{"", "1.5.0", false},
		{">=1.2.0", "", false},
	} {
		if got := SatisfiesTilecastRange(tc.versionRange, tc.version); got != tc.want {
			t.Errorf("SatisfiesTilecastRange(%q, %q) = %v, want %v", tc.versionRange, tc.version, got, tc.want)
		}
	}
}
