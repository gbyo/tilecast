package playlists

import (
	"encoding/json"
	"fmt"

	"github.com/tilecast/tilecast/apps/server/internal/externalplugins"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

const ManifestSchemaExternalPlugins = 20

// ManifestPluginEntry composes separate bundled and external contracts. It
// does not add third-party types or identities to the bundled Plugin SDK.
type ManifestPluginEntry struct {
	Builtin  *plugins.ManifestPlugin
	External *externalplugins.Entry
}

func (e ManifestPluginEntry) MarshalJSON() ([]byte, error) {
	if e.Builtin != nil && e.External == nil && e.Builtin.Type != "external_plugin" {
		return json.Marshal(e.Builtin)
	}
	if e.External != nil && e.Builtin == nil && e.External.Type == "external_plugin" {
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
	if header.Type == "external_plugin" {
		var entry externalplugins.Entry
		if err := json.Unmarshal(raw, &entry); err != nil {
			return err
		}
		e.External = &entry
		e.Builtin = nil
	} else {
		var entry plugins.ManifestPlugin
		if err := json.Unmarshal(raw, &entry); err != nil {
			return err
		}
		e.Builtin = &entry
		e.External = nil
	}
	return nil
}
