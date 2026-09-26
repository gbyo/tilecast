// Package countdownbar is the Countdown Bar plugin.
package countdownbar

import (
	"embed"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/plugins/countdown-bar/server"
)

//go:embed tilecast.plugin.json
var manifest []byte

//go:embed migrations/*.sql
var migrations embed.FS

func New() plugin.Plugin {
	return server.New(plugin.NewBundle(manifest, migrations))
}
