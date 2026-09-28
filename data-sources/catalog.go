// Package datasources embeds the manifests of the declarative Data Source
// modules in this directory (docs/content-extension-model.md §2.1). Each
// module is a directory with a tilecast.datasource.json plus fixtures; the
// Server's content-definition catalog reads the same files datactl
// validates, so no second registry lists Data Sources. Add a Data Source
// by adding its directory. Plugin-owned modules live beneath
// plugins/<plugin>/data-sources/ and reach the Server through the
// generated ledger (data-sources/plugin_sources.gen.go), because Go
// embedding cannot cross into plugins/.
package datasources

import (
	"embed"
	"io/fs"
	"path"
	"sort"
)

// ManifestFile is the name of a Data Source module's manifest.
const ManifestFile = "tilecast.datasource.json"

//go:embed */tilecast.datasource.json
var manifests embed.FS

// Manifest is one embedded Data Source manifest.
type Manifest struct {
	// Dir is the module's directory below data-sources/.
	Dir  string
	JSON []byte
}

// Manifests returns every embedded Data Source manifest in directory order.
func Manifests() ([]Manifest, error) {
	matches, err := fs.Glob(manifests, "*/"+ManifestFile)
	if err != nil {
		return nil, err
	}
	sort.Strings(matches)
	out := make([]Manifest, 0, len(matches))
	for _, match := range matches {
		raw, err := manifests.ReadFile(match)
		if err != nil {
			return nil, err
		}
		out = append(out, Manifest{Dir: path.Dir(match), JSON: raw})
	}
	return out, nil
}
