package plugins

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	bundled "github.com/tilecast/tilecast/plugins"
)

// Plugin identifiers that core code outside a plugin still names while the
// built-in plugins move into plugins/. Each one disappears when its plugin no
// longer needs a core special case.
const (
	EmergencyAlertsID = "emergency_alerts"
	FormsID           = "forms"
	BrandBugID        = "brand_bug"
	NoiseMeterID      = "noise_meter"
)

// Definition is one release-owned plugin as the catalog presents it: what
// Tilecast can do, not whether an installation uses it. It is derived from
// the plugin's tilecast.plugin.json; nothing here is supplied from outside
// the binary, and Version is the definition contract this release
// implements, not a separately updated package.
type Definition struct {
	ID          string
	Version     int
	Name        string
	Description string
	Category    string
	// Icon is a bounded identifier Studio maps to its own icon set; an
	// identifier Studio does not recognize falls back to a generic icon.
	Icon string

	// ManagementPath is the Studio route that manages the plugin. It is a
	// navigation hint, not an authorization boundary.
	ManagementPath string

	InstanceNounSingular string
	InstanceNounPlural   string

	Requirements []Requirement
	Capabilities []string

	Documentation string

	Installable bool

	// PlayerFacing plugins contribute manifest entries, so installing or
	// removing one changes what a screen should receive.
	PlayerFacing bool
}

// Requirement is declarative context shown before installation. It is never
// evaluated: a requirement a site cannot meet produces advice, not a refusal.
type Requirement struct {
	Kind        string `json:"kind"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

const (
	CategoryDisplay    = "Display"
	CategoryAutomation = "Automation"
	CategoryWorkflow   = "Workflow"
	CategoryHardware   = "Hardware"
)

var (
	pluginIDPattern       = plugin.IDPattern
	iconPattern           = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
	managementPathPattern = regexp.MustCompile(`^/[a-z0-9][a-z0-9/-]{0,119}$`)
	knownCategories       = map[string]bool{
		CategoryDisplay: true, CategoryAutomation: true, CategoryWorkflow: true, CategoryHardware: true,
	}
	knownRequirementKinds = map[string]bool{
		"platform": true, "hardware": true, "region": true, "network": true, "provider": true, "player": true,
	}
)

// registry lists every plugin this release can run, in catalog order: by
// name, because no central list decides an order.
var registry = mustDefinitions(bundled.Bundled())

func mustDefinitions(bundle []plugin.Plugin) []Definition {
	definitions := make([]Definition, 0, len(bundle))
	for _, p := range bundle {
		definitions = append(definitions, definitionFromManifest(p.Manifest()))
	}
	sort.SliceStable(definitions, func(i, j int) bool {
		return strings.ToLower(definitions[i].Name) < strings.ToLower(definitions[j].Name)
	})
	if err := validateRegistry(definitions); err != nil {
		panic(err)
	}
	return definitions
}

func definitionFromManifest(m plugin.Manifest) Definition {
	requirements := make([]Requirement, 0, len(m.Requirements))
	for _, requirement := range m.Requirements {
		requirements = append(requirements, Requirement(requirement))
	}
	documentation := ""
	if m.Docs != nil {
		documentation = m.Docs.Reference
	}
	return Definition{
		ID: m.ID, Version: m.DefinitionVersion, Name: m.Name, Description: m.Description,
		Category: m.Category, Icon: m.Icon, ManagementPath: m.StudioRoute(),
		InstanceNounSingular: m.InstanceNoun.Singular, InstanceNounPlural: m.InstanceNoun.Plural,
		Requirements: requirements, Capabilities: append([]string{}, m.Uses...),
		Documentation: documentation, Installable: m.IsInstallable(),
		PlayerFacing: m.Capabilities.PlayerManifest,
	}
}

// Definitions returns the registry in catalog order. The slice is a copy so a
// caller cannot mutate what the rest of the process treats as release data.
func Definitions() []Definition {
	out := make([]Definition, len(registry))
	copy(out, registry)
	return out
}

// Lookup returns a release-owned definition. Unknown IDs — including ones a
// newer release installed — are reported as absent and never run.
func Lookup(id string) (Definition, bool) {
	for _, definition := range registry {
		if definition.ID == id {
			return definition, true
		}
	}
	return Definition{}, false
}

// validateRegistry re-checks the catalog shape the API promises. The SDK has
// already validated each manifest; this guards the translation and the
// cross-plugin rule that identifiers are unique.
func validateRegistry(definitions []Definition) error {
	seen := map[string]bool{}
	for _, d := range definitions {
		switch {
		case !pluginIDPattern.MatchString(d.ID):
			return fmt.Errorf("plugin registry: invalid id %q", d.ID)
		case seen[d.ID]:
			return fmt.Errorf("plugin registry: duplicate id %q", d.ID)
		case d.Version < 1:
			return fmt.Errorf("plugin registry: %s version must be positive", d.ID)
		case strings.TrimSpace(d.Name) == "" || strings.TrimSpace(d.Description) == "":
			return fmt.Errorf("plugin registry: %s needs a name and description", d.ID)
		case !knownCategories[d.Category]:
			return fmt.Errorf("plugin registry: %s has unknown category %q", d.ID, d.Category)
		case !iconPattern.MatchString(d.Icon):
			return fmt.Errorf("plugin registry: %s has invalid icon %q", d.ID, d.Icon)
		case d.ManagementPath != "" && (!managementPathPattern.MatchString(d.ManagementPath) || strings.Contains(d.ManagementPath, "//")):
			return fmt.Errorf("plugin registry: %s has invalid management path %q", d.ID, d.ManagementPath)
		case d.InstanceNounSingular == "" || d.InstanceNounPlural == "":
			return fmt.Errorf("plugin registry: %s needs instance nouns", d.ID)
		}
		for _, requirement := range d.Requirements {
			if !knownRequirementKinds[requirement.Kind] || strings.TrimSpace(requirement.Label) == "" {
				return fmt.Errorf("plugin registry: %s has invalid requirement %+v", d.ID, requirement)
			}
		}
		seen[d.ID] = true
	}
	return nil
}
