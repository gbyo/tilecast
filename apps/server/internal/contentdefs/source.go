package contentdefs

import (
	"fmt"
	"regexp"
	"strings"
)

// Extension source and provenance (docs/content-extension-model.md §4).
//
// The source of an extension is orthogonal to what the extension is: a
// Widget is a Widget whether it ships in Tilecast, is owned by a bundled
// plugin, or comes from a future external package. Source metadata is used
// for availability, collision diagnostics, Studio provenance, support
// bundles, audit, updates, backup/restore, and package trust. It never
// changes the Widget contract.

const (
	SourceKindCore    = "core"
	SourceKindPlugin  = "plugin"
	SourceKindPackage = "package"
)

var (
	pluginIDPattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)
	packageIDPattern = regexp.MustCompile(`^[a-z][a-z0-9]{1,31}(\.[a-z][a-z0-9-]{0,47})+$`)
)

// ExtensionSource says where a Widget definition came from.
type ExtensionSource struct {
	Kind           string `json:"kind,omitempty"`
	PluginID       string `json:"pluginId,omitempty"`
	PackageID      string `json:"packageId,omitempty"`
	PackageVersion string `json:"packageVersion,omitempty"`
	Digest         string `json:"digest,omitempty"`
}

// CoreSource is the source of release-owned definitions.
func CoreSource() ExtensionSource { return ExtensionSource{Kind: SourceKindCore} }

// PluginSource is the source of definitions bundled by a plugin. The id is
// always the stable tilecast.plugin.json id, never the plugin directory
// basename.
func PluginSource(pluginID string) ExtensionSource {
	return ExtensionSource{Kind: SourceKindPlugin, PluginID: pluginID}
}

// Normalized reports the source with an empty kind defaulted to core.
func (source ExtensionSource) Normalized() ExtensionSource {
	if source.Kind == "" {
		source.Kind = SourceKindCore
	}
	return source
}

func (source ExtensionSource) validate() error {
	switch source.Normalized().Kind {
	case SourceKindCore:
		return nil
	case SourceKindPlugin:
		if !pluginIDPattern.MatchString(source.PluginID) {
			return fmt.Errorf("plugin source id %q is invalid", source.PluginID)
		}
		return nil
	case SourceKindPackage:
		if !packageIDPattern.MatchString(source.PackageID) {
			return fmt.Errorf("package source id %q is invalid", source.PackageID)
		}
		if source.PackageVersion == "" || len(source.PackageVersion) > 64 {
			return fmt.Errorf("package source version is invalid")
		}
		if source.Digest == "" || len(source.Digest) > 256 {
			return fmt.Errorf("package source digest is invalid")
		}
		return nil
	default:
		return fmt.Errorf("source kind %q is invalid", source.Kind)
	}
}

// FingerprintString feeds the catalog fingerprint: source identity participates
// in the revision so the same bytes from another source do not alias.
func (source ExtensionSource) FingerprintString() string {
	normalized := source.Normalized()
	switch normalized.Kind {
	case SourceKindPlugin:
		return "plugin:" + normalized.PluginID
	case SourceKindPackage:
		return "package:" + normalized.PackageID + "@" + normalized.PackageVersion + ":" + normalized.Digest
	default:
		return "core"
	}
}

// packageOwnsType reports whether a package contribution equals its package
// ID or lives beneath its namespace.
func packageOwnsType(packageID, componentType string) bool {
	return componentType == packageID || strings.HasPrefix(componentType, packageID+".")
}

// Usable reports whether a contribution from this source may be authored or
// projected given the installed plugin IDs. Core and package contributions
// follow their static definition availability; a plugin contribution
// additionally requires its owning plugin to be installed. The release
// catalog knows what contributions exist, the installation state knows
// which plugin-owned ones are currently available, and effective
// availability is the conjunction of the two with a useful reason.
func (source ExtensionSource) Usable(installed map[string]bool) (bool, string) {
	normalized := source.Normalized()
	if normalized.Kind != SourceKindPlugin {
		return true, ""
	}
	if installed[normalized.PluginID] {
		return true, ""
	}
	return false, fmt.Sprintf("plugin %q is not installed", normalized.PluginID)
}
