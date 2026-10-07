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

// storeJSON is the Plugin Store presentation: curated metadata that changes
// nothing the manifest declares. Static artwork joins it when the plugin
// ships images in store/ and embeds them next to this file.
//
//go:embed tilecast.store.json
var storeJSON []byte

// Plugin is the Forms server contribution.
type Plugin struct {
	plugin.Bundle
	*server.Service
}

func New() plugin.Plugin {
	return &Plugin{Bundle: plugin.NewBundle(manifest, migrations).WithStore(storeJSON, nil), Service: server.NewService()}
}
