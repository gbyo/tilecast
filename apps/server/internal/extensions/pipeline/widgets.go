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
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// WidgetBundle is one installed Widget contribution's verified player
// bundle: the activated package digest, the bundle hash and size the
// manifest claims, and the file to serve. The bytes come from the
// digest-pinned retained layout, which ContentDir re-verifies before
// every use; the hash below then covers exactly what the Player
// downloads.
type WidgetBundle struct {
	PackageID string
	NestedID  string
	Digest    string
	SHA256Hex string
	Size      int64
	Path      string
}

// WidgetBundle resolves the player bundle of one installed Widget
// contribution. Unknown packages, non-Widget contributions, and missing
// or oversized bundles answer installer.ErrNotFound: Players must never
// distinguish "no such package" from "no such bundle".
func (s *Service) WidgetBundle(ctx context.Context, packageID, nestedID string) (WidgetBundle, error) {
	qualified := packageID + "." + nestedID
	installed, err := s.installer.Get(ctx, packageID)
	if err != nil {
		return WidgetBundle{}, err
	}
	contributions, err := s.installer.Contributions(ctx, packageID)
	if err != nil {
		return WidgetBundle{}, err
	}
	var dir string
	for _, contribution := range contributions {
		if contribution.Kind == packagemanifest.ContributionWidget && contribution.ID == qualified {
			dir = contribution.Path
			break
		}
	}
	if dir == "" {
		return WidgetBundle{}, installer.ErrNotFound
	}
	contentDir, err := s.ContentDir(ctx, installed.RegistryReference, installed.Digest)
	if err != nil {
		return WidgetBundle{}, err
	}
	joined := filepath.Join(contentDir, dir, packages.WidgetPayloadRel)
	rel, err := filepath.Rel(contentDir, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return WidgetBundle{}, installer.ErrNotFound
	}
	info, err := os.Stat(joined)
	if err != nil || !info.Mode().IsRegular() {
		return WidgetBundle{}, installer.ErrNotFound
	}
	if info.Size() == 0 || info.Size() > packages.MaxWidgetPayloadBytes {
		return WidgetBundle{}, installer.ErrNotFound
	}
	raw, err := os.ReadFile(joined)
	if err != nil {
		return WidgetBundle{}, installer.ErrNotFound
	}
	if int64(len(raw)) != info.Size() {
		return WidgetBundle{}, fmt.Errorf("bundle changed during read: %w", ErrArtifactInvalid)
	}
	sum := sha256.Sum256(raw)
	return WidgetBundle{
		PackageID: packageID, NestedID: nestedID,
		Digest: installed.Digest, SHA256Hex: hex.EncodeToString(sum[:]),
		Size: info.Size(), Path: joined,
	}, nil
}
