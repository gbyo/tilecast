package playlists

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/tilecast/tilecast/apps/server/internal/externalplugins"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// projectPlayerState appends Plugin API v2 state entries and the verified
// media variants they declare. A media reference that no longer resolves to
// an available, Player-compatible library variant is removed from its entry,
// so a Player never has to verify a claim the manifest does not carry; the
// plugin's player.media@1 binding then answers null for it.
func (s *Service) projectPlayerState(ctx context.Context, manifest *Manifest, screenID uuid.UUID, reported map[string]int, now time.Time) error {
	entries, err := s.plugins.PlayerStateForScreen(ctx, screenID, reported)
	if err != nil {
		return err
	}
	if len(manifest.Plugins)+len(entries) > maxManifestPlugins {
		return fmt.Errorf("%w: more than %d Player manifest plugin entries", ErrConflict, maxManifestPlugins)
	}
	for _, entry := range entries {
		kept := []plugin.MediaRef{}
		for _, ref := range entry.Media {
			variant := ref.VariantID
			asset, resolveErr := s.resolveAssetVariant(ctx, ref.AssetID, &variant)
			if errors.Is(resolveErr, pgx.ErrNoRows) || (resolveErr == nil && !windowAvailable(asset.AvailableFrom, asset.ExpiresAt, now)) {
				continue
			}
			if resolveErr != nil {
				return resolveErr
			}
			kept = append(kept, ref)
			if !manifestHasVariant(manifest, asset.AssetID, asset.VariantID) {
				manifest.Assets = append(manifest.Assets, asset)
			}
		}
		entry.Media = kept
		copy := entry
		manifest.Plugins = append(manifest.Plugins, ManifestPluginEntry{State: &copy})
	}
	return nil
}

// reportsPlayerPluginHost is the only gate for Plugin API v2 state: the
// Player says it hosts v2 contributions. Platform names never decide it.
func reportsPlayerPluginHost(player playerPresentationCapabilities) bool {
	return player.Reported && player.Native[plugin.PlayerPluginHostCapability] >= plugin.PlayerPluginHostVersion
}

func manifestHasVariant(manifest *Manifest, assetID, variantID uuid.UUID) bool {
	for _, existing := range manifest.Assets {
		if existing.AssetID == assetID && existing.VariantID == variantID {
			return true
		}
	}
	return false
}

// maxManifestPlugins is the manifest schema's plugins array limit, which
// Player Core enforces.
const maxManifestPlugins = 64

const (
	ManifestSchemaExternalPlugins = 20
	// ManifestSchemaPlayerPlugins adds Plugin API v2 plugin_state entries.
	ManifestSchemaPlayerPlugins = 21
)

// ManifestPluginEntry composes separate bundled v1, bundled v2, and external
// contracts. It does not add third-party types or identities to the bundled
// Plugin SDK.
type ManifestPluginEntry struct {
	Builtin  *plugins.ManifestPlugin
	State    *plugins.PlayerStateEntry
	External *externalplugins.Entry
}

func (e ManifestPluginEntry) MarshalJSON() ([]byte, error) {
	set := 0
	for _, present := range []bool{e.Builtin != nil, e.State != nil, e.External != nil} {
		if present {
			set++
		}
	}
	switch {
	case set != 1:
	case e.Builtin != nil && !plugin.ReservedPlayerEntryTypes[e.Builtin.Type]:
		return json.Marshal(e.Builtin)
	case e.State != nil && e.State.Type == plugin.PlayerStateEntryType:
		return json.Marshal(e.State)
	case e.External != nil && e.External.Type == "external_plugin":
		return json.Marshal(e.External)
	}
	return nil, fmt.Errorf("manifest plugin entry requires exactly one matching contract")
}

func (e *ManifestPluginEntry) UnmarshalJSON(raw []byte) error {
	var header struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return err
	}
	*e = ManifestPluginEntry{}
	switch header.Type {
	case "external_plugin":
		var entry externalplugins.Entry
		if err := json.Unmarshal(raw, &entry); err != nil {
			return err
		}
		e.External = &entry
	case plugin.PlayerStateEntryType:
		var entry plugins.PlayerStateEntry
		if err := json.Unmarshal(raw, &entry); err != nil {
			return err
		}
		e.State = &entry
	default:
		var entry plugins.ManifestPlugin
		if err := json.Unmarshal(raw, &entry); err != nil {
			return err
		}
		e.Builtin = &entry
	}
	return nil
}
