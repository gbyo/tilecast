// Package forms is the Forms plugin.
package forms

import (
	"embed"
	_ "embed"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/plugins/forms/server"
)

//go:embed tilecast.plugin.json
var manifest []byte

//go:embed migrations/*.sql
var migrations embed.FS

// Store metadata and artwork describe the plugin without changing its capabilities.
//
//go:embed tilecast.store.json
var storeJSON []byte

//go:embed store/*.webp
var storeFiles embed.FS

// Plugin is the Forms server contribution.
type Plugin struct {
	plugin.Bundle
	*server.Service
}

func New() plugin.Plugin {
	return &Plugin{Bundle: plugin.NewBundle(manifest, migrations).WithStore(storeJSON, storeFiles), Service: server.NewService()}
}
