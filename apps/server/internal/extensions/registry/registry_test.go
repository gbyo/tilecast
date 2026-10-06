package registry

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
)

const registryManifest = `{
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
  "contributions": [{"type": "widget", "path": "./widgets/scoreboard"}]
}`

var registryContent = append([]byte{0x1f, 0x8b, 0x08, 0x00}, make([]byte, 128)...)

// fakeRegistry serves one layout's blobs over the distribution endpoints
// oras uses: the version ping, manifest fetch, and blob fetch.
type fakeRegistry struct {
	t        *testing.T
	layout   string
	blobGets int
}

func (f *fakeRegistry) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/v2/")
		if path == "" || path == "/" {
			w.WriteHeader(http.StatusOK)
			return
		}
		segments := strings.Split(path, "/")
		if len(segments) < 3 {
			http.NotFound(w, r)
			return
		}
		kind := segments[len(segments)-2]
		reference := segments[len(segments)-1]
		switch kind {
		case "manifests":
			f.serveBlob(w, r, reference, "application/vnd.oci.image.manifest.v1+json")
		case "blobs":
			f.blobGets++
			f.serveBlob(w, r, reference, "application/octet-stream")
		default:
			http.NotFound(w, r)
		}
	})
}

func (f *fakeRegistry) serveBlob(w http.ResponseWriter, r *http.Request, reference, contentType string) {
	f.t.Helper()
	encoded, found := strings.CutPrefix(reference, "sha256:")
	if !found {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(filepath.Join(f.layout, "blobs", "sha256", encoded))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Docker-Content-Digest", reference)
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(data)
}

func TestPullRoundTrip(t *testing.T) {
	ctx := t.Context()
	source := t.TempDir()
	digest, err := packages.WriteLayout(source, []byte(registryManifest), registryContent)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeRegistry{t: t, layout: source}
	server := httptest.NewServer(fake.handler())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")

	repository := NewRepository(WithPlainHTTP())
	target := t.TempDir()
	if err := repository.Pull(ctx, host+"/acme/tilecast-athletics", digest, target); err != nil {
		t.Fatal(err)
	}
	verified, err := packages.VerifyLayout(target)
	if err != nil {
		t.Fatal(err)
	}
	if verified.Digest != digest {
		t.Fatalf("digest = %s, want %s", verified.Digest, digest)
	}
	if verified.Manifest.PackageID != "acme.athletics" {
		t.Fatalf("manifest = %+v", verified.Manifest)
	}
}

func TestPullUnknownDigest(t *testing.T) {
	ctx := t.Context()
	source := t.TempDir()
	if _, err := packages.WriteLayout(source, []byte(registryManifest), registryContent); err != nil {
		t.Fatal(err)
	}
	fake := &fakeRegistry{t: t, layout: source}
	server := httptest.NewServer(fake.handler())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")

	repository := NewRepository(WithPlainHTTP())
	absent := "sha256:" + strings.Repeat("0", 64)
	if err := repository.Pull(ctx, host+"/acme/tilecast-athletics", absent, t.TempDir()); err == nil {
		t.Fatal("expected an error for an unknown digest")
	}
}

func TestPullRefusesOversizedLayersBeforeCopying(t *testing.T) {
	ctx := t.Context()
	source := t.TempDir()
	digest, err := packages.WriteLayout(source, []byte(registryManifest), registryContent)
	if err != nil {
		t.Fatal(err)
	}
	// Rewrite the served manifest to declare a hostile layer size.
	// Rewriting breaks the manifest digest, so the hostile document is
	// served under the original digest name: the pre-copy size check must
	// fire before any digest comparison of the pulled copy.
	encoded := strings.TrimPrefix(digest, "sha256:")
	manifestPath := filepath.Join(source, "blobs", "sha256", encoded)
	manifestJSON, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		t.Fatal(err)
	}
	layers, ok := manifest["layers"].([]any)
	if !ok || len(layers) != 1 {
		t.Fatalf("fixture manifest = %s", manifestJSON)
	}
	layer, ok := layers[0].(map[string]any)
	if !ok {
		t.Fatalf("fixture layer = %v", layers[0])
	}
	layer["size"] = float64(999999999999)
	hostile, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, hostile, 0o644); err != nil {
		t.Fatal(err)
	}
	fake := &fakeRegistry{t: t, layout: source}
	server := httptest.NewServer(fake.handler())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")

	repository := NewRepository(WithPlainHTTP())
	err = repository.Pull(ctx, host+"/acme/tilecast-athletics", digest, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "declares") {
		t.Fatalf("err = %v, want a declared-size refusal", err)
	}
	if fake.blobGets != 0 {
		t.Fatalf("blob gets = %d, want 0: refusal must precede copying", fake.blobGets)
	}
}

func TestPullRejectsBadInput(t *testing.T) {
	ctx := t.Context()
	repository := NewRepository(WithPlainHTTP())
	if err := repository.Pull(ctx, "not a reference", "sha256:"+strings.Repeat("0", 64), t.TempDir()); err == nil {
		t.Fatal("expected an invalid reference to fail")
	}
	if err := repository.Pull(ctx, "example.com/acme/pkg", "v2.4.1", t.TempDir()); err == nil {
		t.Fatal("expected a tag digest to fail")
	}
}
