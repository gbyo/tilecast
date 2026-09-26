// Package noisemeter is the Noise Meter plugin.
package noisemeter

import (
	_ "embed"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

//go:embed tilecast.plugin.json
var manifest []byte

// Plugin is the Noise Meter server contribution.
type Plugin struct {
	plugin.Bundle
}

func New() plugin.Plugin {
	return &Plugin{Bundle: plugin.NewBundle(manifest, nil)}
}
