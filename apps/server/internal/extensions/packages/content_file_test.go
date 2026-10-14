package packages

import (
	"archive/tar"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifiedContentFileBoundsIdentityAndCancellation(t *testing.T) {
	layout := t.TempDir()
	_, err := WriteLayout(layout, []byte(extractManifest), tarGzip(t, []tarEntry{{name: "plugin/runtime/index.js", body: "verified code"}}))
	if err != nil {
		t.Fatal(err)
	}
	verified, err := VerifyLayout(layout)
	if err != nil {
		t.Fatal(err)
	}
	body, err := ReadVerifiedContentFile(context.Background(), layout, verified, "./plugin/runtime/index.js", 100)
	if err != nil || string(body) != "verified code" {
		t.Fatalf("verified file: %q %v", body, err)
	}
	for _, request := range []struct {
		name string
		max  int64
	}{{"../secret", 100}, {"plugin/missing.js", 100}, {"plugin/runtime/index.js", 1}} {
		if _, err := ReadVerifiedContentFile(context.Background(), layout, verified, request.name, request.max); err == nil {
			t.Fatalf("invalid read accepted: %+v", request)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ReadVerifiedContentFile(ctx, layout, verified, "plugin/runtime/index.js", 100); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled read: %v", err)
	}
	// Preserve the same filename while replacing its compressed bytes. The
	// reader must authenticate the stream it read, not the earlier check.
	path := filepath.Join(layout, "blobs", "sha256", strings.TrimPrefix(verified.ContentDigests[0], "sha256:"))
	if err := os.WriteFile(path, tarGzip(t, []tarEntry{{name: "plugin/runtime/index.js", body: "altered code"}}), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadVerifiedContentFile(context.Background(), layout, verified, "plugin/runtime/index.js", 100); err == nil {
		t.Fatal("altered layer returned executable bytes")
	}
}

func TestVerifiedContentFileRejectsLinksAndDuplicateEntries(t *testing.T) {
	for _, entries := range [][]tarEntry{
		{{name: "plugin/runtime/index.js", typeflag: tar.TypeSymlink, linkname: "other.js"}},
		{{name: "plugin/runtime/index.js", body: "one"}, {name: "plugin/runtime/index.js", body: "two"}},
	} {
		layout := t.TempDir()
		if _, err := WriteLayout(layout, []byte(extractManifest), tarGzip(t, entries)); err != nil {
			t.Fatal(err)
		}
		verified, err := VerifyLayout(layout)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ReadVerifiedContentFile(context.Background(), layout, verified, "plugin/runtime/index.js", 100); err == nil {
			t.Fatal("invalid archive returned executable bytes")
		}
	}
}
