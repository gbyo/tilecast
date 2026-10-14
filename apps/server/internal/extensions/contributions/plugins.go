package contributions

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/sandbox"
	"github.com/tilecast/tilecast/apps/server/internal/externalplugins"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
	externalplugin "github.com/tilecast/tilecast/packages/package-sdk/go/plugin"
)

// pluginRefreshInterval spaces the background refreshes that unknown
// epochs may start, so a stream of stale requests costs one rebuild.
const pluginRefreshInterval = 30 * time.Second

// CurrentPluginPayload answers from the catalog snapshot and never rebuilds
// it: callers hold the package execution lock, which a pull must not wait
// under. An epoch the snapshot loaded or rejected is a final answer. An
// unknown epoch means another Server replica changed the package lifecycle,
// so the answer is negative now and a throttled background refresh makes the
// next request succeed.
func (s *Service) CurrentPluginPayload(_ context.Context, packageID, nestedID string, epoch uuid.UUID) (PluginPayload, bool, error) {
	if payload, ok := s.PluginPayload(packageID, nestedID); ok && payload.ExecutionEpoch == epoch {
		return payload, true, nil
	}
	if epoch == uuid.Nil {
		return PluginPayload{}, false, nil
	}
	if snapshot := s.payloads.Load(); snapshot != nil && (snapshot.epochs[packageID] == epoch || snapshot.skipped[packageID] == epoch) {
		return PluginPayload{}, false, nil
	}
	s.refreshInBackground()
	return PluginPayload{}, false, nil
}

// refreshInBackground recomposes the catalog outside any request. It may
// pull package bytes, so it runs detached with its own deadline.
func (s *Service) refreshInBackground() {
	if !s.refreshing.CompareAndSwap(false, true) {
		return
	}
	now := time.Now().UnixNano()
	if now-s.lastRefresh.Load() < int64(pluginRefreshInterval) {
		s.refreshing.Store(false)
		return
	}
	s.lastRefresh.Store(now)
	go func() {
		defer s.refreshing.Store(false)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := s.Rebuild(ctx); !SkipsOnly(err) {
			s.logger.Warn("external plugin catalog refresh failed", "error", err)
		}
	}()
}

// PluginPayload is verified catalog metadata, separate from bundled types.
type PluginPayload = externalplugins.Payload

func (s *Service) PluginPayload(packageID, nestedID string) (PluginPayload, bool) {
	snapshot := s.payloads.Load()
	if snapshot == nil {
		return PluginPayload{}, false
	}
	payload, ok := snapshot.plugins[payloadKey{packageID: packageID, nestedID: nestedID}]
	payload.Descriptor.Runtime.Surfaces = append([]string{}, payload.Descriptor.Runtime.Surfaces...)
	return payload, ok
}

func decodePluginPayloads(contentDir string, manifest packagemanifest.Manifest, digest string, verifiedFile func(string, string, int64) ([]byte, error)) (map[payloadKey]PluginPayload, error) {
	result := make(map[payloadKey]PluginPayload)
	for _, contribution := range manifest.Contributions {
		if contribution.Type != packagemanifest.ContributionPlugin {
			continue
		}
		root := filepath.Join(contentDir, contribution.Path)
		rel, err := filepath.Rel(contentDir, root)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("plugin contribution escapes package")
		}
		read := func(file string, max int64) ([]byte, error) {
			if verifiedFile != nil {
				return verifiedFile(contribution.Path, file, max)
			}
			return readPluginFile(filepath.Join(root, file), max)
		}
		raw, err := read("tilecast.plugin.json", packages.MaxNestedManifestBytes)
		if err != nil {
			return nil, err
		}
		var header struct {
			APIVersion packagemanifest.APIVersionNum `json:"apiVersion"`
		}
		if err := json.Unmarshal(raw, &header); err != nil {
			return nil, err
		}
		if header.APIVersion == 1 {
			// API 1 names compiled Go/React entrypoints. Those external rows
			// remain inert and cannot be reinterpreted as a Player runtime.
			continue
		}
		descriptor, err := externalplugin.Parse(raw)
		if err != nil {
			return nil, err
		}
		qualified := manifest.PackageID + "." + descriptor.ID
		if len(qualified) > 128 {
			return nil, fmt.Errorf("external plugin identity exceeds 128 bytes")
		}
		bundle, err := read(externalplugin.BundlePath, packages.MaxWidgetPayloadBytes)
		if err != nil {
			return nil, err
		}
		frame, err := sandbox.AssemblePluginFrame(string(bundle))
		if err != nil {
			return nil, err
		}
		key := payloadKey{packageID: manifest.PackageID, nestedID: descriptor.ID}
		if _, exists := result[key]; exists {
			return nil, fmt.Errorf("duplicate external plugin contribution %s", qualified)
		}
		result[key] = PluginPayload{PackageID: manifest.PackageID, ContributionID: qualified, PackageDigest: digest, Descriptor: descriptor, FrameSHA256Hex: frame.SHA256Hex, FrameSize: frame.Size}
	}
	return result, nil
}

func readPluginFile(path string, max int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > max {
		return nil, fmt.Errorf("external plugin file is missing or exceeds its bound")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) != info.Size() {
		return nil, fmt.Errorf("external plugin file changed during read")
	}
	return raw, nil
}
