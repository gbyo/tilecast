package packages

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"strconv"
	"testing"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

const extractManifest = `{
  "apiVersion": 1,
  "packageId": "acme.athletics",
  "packageVersion": "2.4.1",
  "name": "Athletics",
  "description": "Scoreboards.",
  "publisher": {"id": "acme", "name": "Acme"},
  "repository": "https://github.com/acme/tilecast-athletics",
  "license": "MIT",
  "tilecast": {"version": ">=1.2.0 <2.0.0"},
  "distribution": {"oci": "example.com/acme/tilecast-athletics"},
  "contributions": [
    {"type": "widget", "path": "./widgets/scoreboard"},
    {"type": "dataSource", "path": "./data-sources/schedule"},
    {"type": "plugin", "path": "./plugin"}
  ]
}`

type tarEntry struct {
	name     string
	body     string
	typeflag byte
	linkname string
}

func tarGzip(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var raw bytes.Buffer
	gzipWriter := gzip.NewWriter(&raw)
	tarWriter := tar.NewWriter(gzipWriter)
	for _, entry := range entries {
		flag := entry.typeflag
		if flag == 0 {
			flag = tar.TypeReg
		}
		if err := tarWriter.WriteHeader(&tar.Header{
			Name:     entry.name,
			Mode:     0o644,
			Size:     int64(len(entry.body)),
			Typeflag: flag,
			Linkname: entry.linkname,
		}); err != nil {
			t.Fatal(err)
		}
		if flag == tar.TypeReg {
			if _, err := tarWriter.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return raw.Bytes()
}

func nestedManifestDoc(id string) string {
	return `{"apiVersion":1,"id":"` + id + `"}`
}

func extractFixture(t *testing.T, entries []tarEntry) (string, VerifiedPackage) {
	t.Helper()
	layout := t.TempDir()
	if _, err := WriteLayout(layout, []byte(extractManifest), tarGzip(t, entries)); err != nil {
		t.Fatal(err)
	}
	verified, err := VerifyLayout(layout)
	if err != nil {
		t.Fatal(err)
	}
	return layout, verified
}

func TestExtractRoundTrip(t *testing.T) {
	layout, verified := extractFixture(t, []tarEntry{
		{name: "widgets/scoreboard/tilecast.widget.json", body: nestedManifestDoc("scoreboard")},
		{name: "data-sources/schedule/tilecast.datasource.json", body: nestedManifestDoc("schedule")},
		{name: "plugin/tilecast.plugin.json", body: nestedManifestDoc("athletics")},
		{name: "widgets/scoreboard/index.js", body: "export default 1;"},
	})
	dest := t.TempDir() + "/content"
	if err := ExtractContent(layout, verified, dest); err != nil {
		t.Fatal(err)
	}
	contributions, err := ReadContributions(dest, verified.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	if len(contributions) != 3 {
		t.Fatalf("contributions = %d, want 3", len(contributions))
	}
	want := map[string]string{
		"widget":     "acme.athletics.scoreboard",
		"dataSource": "acme.athletics.schedule",
		"plugin":     "acme.athletics.athletics",
	}
	for _, contribution := range contributions {
		if want[contribution.Kind] != contribution.ID {
			t.Fatalf("contributions = %+v", contributions)
		}
		if !packagemanifest.InNamespace(contribution.ID, verified.Manifest.PackageID) {
			t.Fatalf("contribution %q escapes its namespace", contribution.ID)
		}
	}
}

func TestExtractRefusesHostileEntries(t *testing.T) {
	for name, entries := range map[string][]tarEntry{
		"traversal":        {{name: "../evil.txt", body: "x"}},
		"nested-traversal": {{name: "a/../../evil.txt", body: "x"}},
		"absolute":         {{name: "/etc/evil.txt", body: "x"}},
		"symlink":          {{name: "link", typeflag: tar.TypeSymlink, linkname: "/etc/passwd"}},
		"hardlink":         {{name: "link", body: "x"}, {name: "hard", typeflag: tar.TypeLink, linkname: "link"}},
		"duplicate":        {{name: "dup.txt", body: "a"}, {name: "dup.txt", body: "b"}},
	} {
		t.Run(name, func(t *testing.T) {
			layout, verified := extractFixture(t, entries)
			if err := ExtractContent(layout, verified, t.TempDir()+"/content"); err == nil {
				t.Fatal("expected a refusal")
			}
		})
	}
}

func TestExtractRefusesTooManyFiles(t *testing.T) {
	entries := make([]tarEntry, 0, MaxExtractedFiles+1)
	for i := 0; i <= MaxExtractedFiles; i++ {
		entries = append(entries, tarEntry{name: "file-" + strconv.Itoa(i) + ".txt", body: "x"})
	}
	layout, verified := extractFixture(t, entries)
	if err := ExtractContent(layout, verified, t.TempDir()+"/content"); err == nil {
		t.Fatal("expected a file-count refusal")
	}
}

func TestReadContributionsRejects(t *testing.T) {
	good := []tarEntry{
		{name: "widgets/scoreboard/tilecast.widget.json", body: nestedManifestDoc("scoreboard")},
		{name: "data-sources/schedule/tilecast.datasource.json", body: nestedManifestDoc("schedule")},
		{name: "plugin/tilecast.plugin.json", body: nestedManifestDoc("athletics")},
	}
	extract := func(t *testing.T, entries []tarEntry) (string, VerifiedPackage) {
		t.Helper()
		layout, verified := extractFixture(t, entries)
		dest := t.TempDir() + "/content"
		if err := ExtractContent(layout, verified, dest); err != nil {
			t.Fatal(err)
		}
		return dest, verified
	}

	t.Run("missing nested manifest", func(t *testing.T) {
		dest, verified := extract(t, good[:2])
		if _, err := ReadContributions(dest, verified.Manifest); err == nil {
			t.Fatal("expected a missing-manifest refusal")
		}
	})

	t.Run("bad nested id", func(t *testing.T) {
		entries := append([]tarEntry(nil), good...)
		entries[0] = tarEntry{name: entries[0].name, body: nestedManifestDoc("Not An ID")}
		dest, verified := extract(t, entries)
		if _, err := ReadContributions(dest, verified.Manifest); err == nil {
			t.Fatal("expected a bad-identity refusal")
		}
	})

	t.Run("unsupported api version", func(t *testing.T) {
		entries := append([]tarEntry(nil), good...)
		entries[0] = tarEntry{name: entries[0].name, body: `{"apiVersion":99,"id":"scoreboard"}`}
		dest, verified := extract(t, entries)
		if _, err := ReadContributions(dest, verified.Manifest); err == nil {
			t.Fatal("expected an API-version refusal")
		}
	})

	t.Run("corrupt nested manifest", func(t *testing.T) {
		entries := append([]tarEntry(nil), good...)
		entries[0] = tarEntry{name: entries[0].name, body: `{"apiVersion":`}
		dest, verified := extract(t, entries)
		if _, err := ReadContributions(dest, verified.Manifest); err == nil {
			t.Fatal("expected a corrupt-manifest refusal")
		}
	})

	t.Run("unknown contribution type", func(t *testing.T) {
		dest, verified := extract(t, good)
		manifest := verified.Manifest
		manifest.Contributions = []packagemanifest.Contribution{{Type: "gadget", Path: "./gadget"}}
		if _, err := ReadContributions(dest, manifest); err == nil {
			t.Fatal("expected an unknown-type refusal")
		}
	})
}
