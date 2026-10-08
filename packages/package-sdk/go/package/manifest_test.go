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

func TestFieldValidators(t *testing.T) {
	if !ValidPackageID("acme.athletics") || ValidPackageID("athletics") || ValidPackageID("tilecast.athletics") {
		t.Fatal("ValidPackageID mismatch")
	}
	if !ValidSemVer("2.4.1") || ValidSemVer("2.4") {
		t.Fatal("ValidSemVer mismatch")
	}
	if !ValidOCIReference("ghcr.io/acme/pkg") || ValidOCIReference("ghcr.io/acme/pkg:tag") || ValidOCIReference("ghcr.io/acme/pkg@sha256:abc") {
		t.Fatal("ValidOCIReference mismatch")
	}
	if !ValidDigest("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef") || ValidDigest("v2.4.1") {
		t.Fatal("ValidDigest mismatch")
	}
	if !ValidPublisherID("acme") || ValidPublisherID("acme.athletics") {
		t.Fatal("ValidPublisherID mismatch")
	}
	if !ValidTilecastRange(">=1.2.0 <2.0.0") || ValidTilecastRange(">=1.2.0 || <2.0.0") {
		t.Fatal("ValidTilecastRange mismatch")
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

func TestCompareSemver(t *testing.T) {
	for _, tc := range []struct {
		left, right string
		want        int
		ok          bool
	}{
		{"1.0.0", "1.0.0", 0, true},
		{"1.0.0", "2.0.0", -1, true},
		{"2.4.1", "2.4.0", 1, true},
		{"1.10.0", "1.9.0", 1, true},
		{"1.0.0-alpha", "1.0.0", -1, true},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1, true},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1, true},
		{"1.0.0-alpha.beta", "1.0.0-beta", -1, true},
		{"1.0.0-beta", "1.0.0-beta.2", -1, true},
		{"1.0.0-beta.2", "1.0.0-beta.11", -1, true},
		{"1.0.0-beta.11", "1.0.0-rc.1", -1, true},
		{"1.0.0+build", "1.0.0", 0, true},
		{"1.0.0-alpha+1", "1.0.0-alpha", 0, true},
		{"2.4", "2.4.0", 0, false},
		{"1.0.0-", "1.0.0", 0, false},
		{"", "1.0.0", 0, false},
	} {
		got, ok := CompareSemver(tc.left, tc.right)
		if got != tc.want || ok != tc.ok {
			t.Errorf("CompareSemver(%q, %q) = %d, %v; want %d, %v", tc.left, tc.right, got, ok, tc.want, tc.ok)
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

// TestParseAcceptsSampleManifest keeps the Hello Services sample
// installable: the server-authoritative parser must accept the exact
// manifest the sample ships.
func TestParseAcceptsSampleManifest(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "package-samples", "hello-services", "tilecast.package.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if manifest.APIVersion != 3 || manifest.PackageID != "example.hello-services" {
		t.Fatalf("manifest = %+v", manifest)
	}
	if manifest.Capabilities == nil || len(manifest.Capabilities.Services) != 3 {
		t.Fatalf("services = %+v", manifest.Capabilities)
	}
}
