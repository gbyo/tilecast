// Package externalplugin owns the external Plugin API v2 descriptor.
// Bundled Plugin API v1 is a separate contract and is unchanged.
package externalplugin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"unicode/utf8"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

const (
	APIVersion        = 2
	RuntimeVersion    = 1
	RuntimeCapability = "plugin.external-runtime"
	BundlePath        = "runtime/index.js"
)

var idPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)
var Surfaces = []string{"strip.top", "strip.bottom", "corner.top-left", "corner.top-right", "corner.bottom-left", "corner.bottom-right", "overlay"}
var Tiers = []string{"emergency", "live", "scheduled", "ambient"}

type Manifest struct {
	APIVersion        packagemanifest.APIVersionNum `json:"apiVersion"`
	ID                string                        `json:"id"`
	DefinitionVersion packagemanifest.IntegerNum    `json:"definitionVersion"`
	Name              string                        `json:"name"`
	Description       string                        `json:"description"`
	Capabilities      Capabilities                  `json:"capabilities"`
	Runtime           Runtime                       `json:"runtime"`
}
type Capabilities struct {
	PlayerManifest bool `json:"playerManifest"`
}
type Runtime struct {
	Surfaces []string `json:"surfaces"`
	Tier     string   `json:"tier"`
}

func Parse(raw []byte) (Manifest, error) {
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("external plugin descriptor: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return Manifest{}, fmt.Errorf("external plugin descriptor: trailing JSON")
	}
	if err := Validate(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func Validate(manifest Manifest) error {
	invalid := func(reason string) error { return fmt.Errorf("external plugin descriptor: %s", reason) }
	if manifest.APIVersion != APIVersion {
		return invalid("apiVersion must be 2")
	}
	if !idPattern.MatchString(manifest.ID) {
		return invalid("id must be a bounded local plugin identity")
	}
	if manifest.DefinitionVersion < 1 || manifest.DefinitionVersion > 1_000_000 {
		return invalid("definitionVersion must be 1 to 1000000")
	}
	if utf8.RuneCountInString(manifest.Name) < 1 || utf8.RuneCountInString(manifest.Name) > 80 || utf8.RuneCountInString(manifest.Description) < 1 || utf8.RuneCountInString(manifest.Description) > 500 {
		return invalid("name or description exceeds its text bound")
	}
	if !manifest.Capabilities.PlayerManifest {
		return invalid("playerManifest must be true")
	}
	if len(manifest.Runtime.Surfaces) < 1 || len(manifest.Runtime.Surfaces) > len(Surfaces) {
		return invalid("declare 1 to 7 surfaces")
	}
	seen := make(map[string]bool)
	for _, slot := range manifest.Runtime.Surfaces {
		if seen[slot] || !contains(Surfaces, slot) {
			return invalid("surface declarations must be valid and unique")
		}
		seen[slot] = true
	}
	if !contains(Tiers, manifest.Runtime.Tier) {
		return invalid("tier is not supported")
	}
	return nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
