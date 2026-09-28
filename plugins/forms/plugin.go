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

// Plugin is the Forms server contribution.
type Plugin struct {
	plugin.Bundle
	*server.Service
}

func New() plugin.Plugin {
	return &Plugin{Bundle: plugin.NewBundle(manifest, migrations), Service: server.NewService()}
}
