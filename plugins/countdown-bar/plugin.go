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

// storeJSON is the Plugin Store presentation: curated metadata that changes
// nothing the manifest declares. Static artwork joins it when the plugin
// ships images in store/ and embeds them next to this file.
//
//go:embed tilecast.store.json
var storeJSON []byte

// automationJSON is the resolved Automation Contract v1 document pluginctl
// generates from automation.yaml. It is data, not code: the host serves it
// to operator clients, which dispatch on it without naming this plugin in
// their own source.
//
//go:embed automation.gen.json
var automationJSON []byte

func New() plugin.Plugin {
	return server.New(plugin.NewBundle(manifest, migrations).WithStore(storeJSON, nil), automationJSON)
}
