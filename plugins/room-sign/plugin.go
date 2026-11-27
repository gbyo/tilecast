// Package roomsign is the Room Sign plugin: a meeting room's current and
// next meeting from Google Calendar, published as a feed for the Room Sign
// Widget.
package roomsign

import (
	"embed"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/plugins/room-sign/server"
)

//go:embed tilecast.plugin.json
var manifest []byte

// Store metadata and artwork describe the plugin without changing its capabilities.
//
//go:embed tilecast.store.json
var storeJSON []byte

//go:embed store/*.webp
var storeFiles embed.FS

// automationJSON is the Automation Contract v1 document pluginctl
// generates from the manifest's instance kind, for operator clients.
//
//go:embed automation.gen.json
var automationJSON []byte

// New returns the plugin.
func New() plugin.Plugin {
	return server.New(plugin.NewBundle(manifest, nil).WithStore(storeJSON, storeFiles), automationJSON)
}
