package packages

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const layoutManifest = `{
  "apiVersion": 1,
  "packageId": "acme.athletics",
  "packageVersion": "2.4.1",
  "name": "Athletics",
  "description": "Scoreboards.",
  "publisher": {"id": "acme", "name": "Acme"},
  "repository": "https://github.com/acme/tilecast-athletics",
  "license": "MIT",
  "tilecast": {"version": ">=1.2.0 <2.0.0"},
  "distribution": {"oci": "ghcr.io/acme/tilecast-athletics"},
  "contributions": [{"type": "widget", "path": "./widgets/scoreboard"}]
}`

// gzip header plus padding: opaque content bytes are enough, since the
// verifier checks digests, not archives.
var layoutContent = append([]byte{0x1f, 0x8b, 0x08, 0x00}, make([]byte, 64)...)

func writeLayout(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	digest, err := WriteLayout(dir, []byte(layoutManifest), layoutContent)
	if err != nil {
		t.Fatal(err)
	}
	return dir, digest
}

func TestVerifyLayoutRoundTrip(t *testing.T) {
	dir, digest := writeLayout(t)
	verified, err := VerifyLayout(dir)
	if err != nil {
		t.Fatal(err)
	}
	if verified.Digest != digest {
		t.Fatalf("digest = %s, want %s", verified.Digest, digest)
	}
	if verified.Manifest.PackageID != "acme.athletics" || verified.Manifest.PackageVersion != "2.4.1" {
		t.Fatalf("manifest = %+v", verified.Manifest)
	}
	if len(verified.ContentDigests) != 1 {
		t.Fatalf("content digests = %v", verified.ContentDigests)
	}
	sum := sha256.Sum256(layoutContent)
	if verified.ContentDigests[0] != "sha256:"+hex.EncodeToString(sum[:]) {
		t.Fatalf("content digest = %s", verified.ContentDigests[0])
	}
}

func corruptBlob(t *testing.T, dir, digest string) {
	t.Helper()
	encoded, _ := strings.CutPrefix(digest, "sha256:")
	path := filepath.Join(dir, "blobs", "sha256", encoded)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data[0] ^= 0xff
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadBlobRejectsMalformedDescriptorBeforeFilesystemAccess(t *testing.T) {
	malformed := descriptor{
		Digest: "sha256:../" + strings.Repeat("a", 61),
		Size:   0,
	}
	if _, err := readBlob(t.TempDir(), malformed, MaxContentBytes); err == nil {
		t.Fatal("expected malformed digest to fail")
	}

	negative := descriptor{
		Digest: "sha256:" + strings.Repeat("a", 64),
		Size:   -1,
	}
	if _, err := readBlob(t.TempDir(), negative, MaxContentBytes); err == nil {
		t.Fatal("expected negative descriptor size to fail")
	}
}

func TestStoreBlobReturnsWriteError(t *testing.T) {
	dir := t.TempDir()
	if _, err := storeBlob(dir, MediaTypePackageConfig, []byte("manifest")); err == nil {
		t.Fatal("expected missing blob directory to fail")
	}
}

func TestVerifyLayoutFailsClosed(t *testing.T) {
	t.Run("missing directory", func(t *testing.T) {
		if _, err := VerifyLayout(filepath.Join(t.TempDir(), "absent")); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("tampered config blob", func(t *testing.T) {
		dir, digest := writeLayout(t)
		encoded, _ := strings.CutPrefix(digest, "sha256:")
		manifestJSON, err := os.ReadFile(filepath.Join(dir, "blobs", "sha256", encoded))
		if err != nil {
			t.Fatal(err)
		}
		var manifest struct {
			Config struct {
				Digest string `json:"digest"`
			} `json:"config"`
		}
		if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
			t.Fatal(err)
		}
		corruptBlob(t, dir, manifest.Config.Digest)
		if _, err := VerifyLayout(dir); err == nil {
			t.Fatal("expected a digest mismatch")
		}
	})
	t.Run("tampered content blob", func(t *testing.T) {
		dir, _ := writeLayout(t)
		verified, err := VerifyLayout(dir)
		if err != nil {
			t.Fatal(err)
		}
		corruptBlob(t, dir, verified.ContentDigests[0])
		if _, err := VerifyLayout(dir); err == nil {
			t.Fatal("expected a digest mismatch")
		}
	})
	t.Run("tampered manifest blob", func(t *testing.T) {
		dir, digest := writeLayout(t)
		corruptBlob(t, dir, digest)
		if _, err := VerifyLayout(dir); err == nil {
			t.Fatal("expected a digest mismatch")
		}
	})
	t.Run("foreign artifact", func(t *testing.T) {
		dir, _ := writeLayout(t)
		indexPath := filepath.Join(dir, "index.json")
		data, err := os.ReadFile(indexPath)
		if err != nil {
			t.Fatal(err)
		}
		replaced := strings.Replace(string(data), ArtifactTilecastPackage, "application/vnd.example.other", 1)
		if err := os.WriteFile(indexPath, []byte(replaced), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyLayout(dir); err == nil {
			t.Fatal("expected an artifact type rejection")
		}
	})
	t.Run("invalid manifest document", func(t *testing.T) {
		dir := t.TempDir()
		bad := strings.Replace(layoutManifest, `"2.4.1"`, `"2.4"`, 1)
		if _, err := WriteLayout(dir, []byte(bad), layoutContent); err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyLayout(dir); err == nil {
			t.Fatal("expected a manifest rejection")
		}
	})
}
