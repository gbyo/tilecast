// Package menuboard is the Square Menu Board plugin: an item library from
// Square published as a menu feed for the Menu Widget.
package menuboard

import (
	"embed"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/plugins/menu-board/server"
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
