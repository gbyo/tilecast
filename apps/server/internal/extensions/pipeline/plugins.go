package pipeline

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/sandbox"
	externalplugin "github.com/tilecast/tilecast/packages/package-sdk/go/plugin"
)

// PluginFile reads code from its authenticated layer rather than trusting the
// derived extraction directory. Runtime modules use the same reader.
func (s *Service) PluginFile(ctx context.Context, ref, digest, path, file string, max int64) ([]byte, error) {
	layout, _, err := s.ensureContent(ctx, ref, digest)
	if err != nil {
		return nil, err
	}
	verified, err := packages.VerifyLayout(layout)
	if err != nil {
		return nil, err
	}
	return packages.ReadVerifiedContentFile(ctx, layout, verified, filepath.ToSlash(filepath.Join(path, file)), max)
}

// PluginFrame reads one atomically captured activation and owned contribution
// from its verified retained OCI artifact. Every emitted byte is covered by
// the same deterministic assembler the catalog hashed.
func (s *Service) PluginFrame(ctx context.Context, packageID, nestedID string) (sandbox.AssembledFrame, error) {
	var ref, digest, path string
	err := s.db.QueryRow(ctx, `SELECT installed.registry_reference,installed.digest,contribution.contribution_path
 FROM installed_packages installed JOIN installed_package_contributions contribution
 ON contribution.organization_id=installed.organization_id AND contribution.package_id=installed.package_id
 WHERE installed.package_id=$1 AND contribution.kind='plugin' AND contribution.contribution_id=$2`, packageID, packageID+"."+nestedID).Scan(&ref, &digest, &path)
	if errors.Is(err, pgx.ErrNoRows) {
		return sandbox.AssembledFrame{}, installer.ErrNotFound
	}
	if err != nil {
		return sandbox.AssembledFrame{}, err
	}
	descriptorRaw, err := s.PluginFile(ctx, ref, digest, path, "tilecast.plugin.json", packages.MaxNestedManifestBytes)
	if err != nil {
		return sandbox.AssembledFrame{}, err
	}
	descriptor, err := externalplugin.Parse(descriptorRaw)
	if err != nil || descriptor.ID != nestedID {
		return sandbox.AssembledFrame{}, installer.ErrNotFound
	}
	bundle, err := s.PluginFile(ctx, ref, digest, path, externalplugin.BundlePath, packages.MaxWidgetPayloadBytes)
	if err != nil {
		return sandbox.AssembledFrame{}, err
	}
	return sandbox.AssemblePluginFrame(string(bundle))
}
