package pipeline

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/wasm"
)

// StudioEntry is one installed package's sandboxed Studio UI entry page:
// the activated digest, the entry hash and size, and the file to serve.
// The bytes come from the digest-pinned retained layout, which ContentDir
// re-verifies before every use. The entry must be self-contained inline
// HTML: the frame policy grants no subresource loads.
type StudioEntry struct {
	PackageID string
	Digest    string
	SHA256Hex string
	Size      int64
	Path      string
}

// StudioEntry resolves the Studio UI entry page of one installed package.
// Unknown packages, packages without a Studio UI capability, and missing
// or oversized entries answer installer.ErrNotFound, mirroring the
// Widget bundle lookup.
func (s *Service) StudioEntry(ctx context.Context, packageID string) (StudioEntry, error) {
	installed, err := s.installer.Get(ctx, packageID)
	if err != nil {
		return StudioEntry{}, err
	}
	manifest, err := s.installer.Manifest(ctx, packageID)
	if err != nil {
		return StudioEntry{}, err
	}
	if manifest.Capabilities == nil || manifest.Capabilities.StudioUI == nil {
		return StudioEntry{}, installer.ErrNotFound
	}
	contentDir, err := s.ContentDir(ctx, installed.RegistryReference, installed.Digest)
	if err != nil {
		return StudioEntry{}, err
	}
	joined := filepath.Join(contentDir, manifest.Capabilities.StudioUI.Entry)
	rel, err := filepath.Rel(contentDir, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return StudioEntry{}, installer.ErrNotFound
	}
	info, err := os.Stat(joined)
	if err != nil || !info.Mode().IsRegular() {
		return StudioEntry{}, installer.ErrNotFound
	}
	if info.Size() == 0 || info.Size() > wasm.MaxStudioEntryBytes {
		return StudioEntry{}, installer.ErrNotFound
	}
	raw, err := os.ReadFile(joined)
	if err != nil {
		return StudioEntry{}, installer.ErrNotFound
	}
	if int64(len(raw)) != info.Size() {
		return StudioEntry{}, fmt.Errorf("entry changed during read: %w", ErrArtifactInvalid)
	}
	sum := sha256.Sum256(raw)
	return StudioEntry{
		PackageID: packageID,
		Digest:    installed.Digest, SHA256Hex: hex.EncodeToString(sum[:]),
		Size: info.Size(), Path: joined,
	}, nil
}
