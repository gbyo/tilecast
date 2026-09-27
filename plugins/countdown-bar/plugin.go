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

// automationJSON is the resolved Automation Contract v1 document pluginctl
// generates from automation.yaml. It is data, not code: the host serves it
// to operator clients, which dispatch on it without naming this plugin in
// their own source.
//
//go:embed automation.gen.json
var automationJSON []byte

func New() plugin.Plugin {
	return server.New(plugin.NewBundle(manifest, migrations), automationJSON)
}
