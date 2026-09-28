// Package widgets embeds the manifests of the Widgets V2 modules in this
// directory (docs/widgets-v2.md). Each Widget is a directory with a
// tilecast.widget.json; the Server's content-definition catalog reads the
// same files the Player Runtime and Studio discover, so no second registry
// lists Widgets. Add a Widget by adding its directory.
package widgets

import (
	"embed"
	"io/fs"
	"path"
	"sort"
)

// ManifestFile is the name of a Widget module's manifest.
const ManifestFile = "tilecast.widget.json"

//go:embed */tilecast.widget.json
var manifests embed.FS

// Manifest is one embedded Widget manifest.
type Manifest struct {
	// Dir is the Widget's directory below widgets/.
	Dir  string
	JSON []byte
}

// Manifests returns every embedded Widget manifest in directory order.
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
