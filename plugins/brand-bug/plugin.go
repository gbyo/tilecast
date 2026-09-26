// Package brandbug is the Brand Bug / Watermark plugin.
package brandbug

import (
	_ "embed"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

//go:embed tilecast.plugin.json
var manifest []byte

// Plugin is the Brand Bug / Watermark server contribution.
type Plugin struct {
	plugin.Bundle
}

func New() plugin.Plugin {
	return &Plugin{Bundle: plugin.NewBundle(manifest, nil)}
}
