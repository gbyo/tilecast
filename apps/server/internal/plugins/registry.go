package plugins

import (
	"fmt"
	"regexp"
	"strings"
)

// Plugin identifiers are compiled constants. Runtime code names a plugin by one
// of these rather than by a string literal so a typo fails to compile instead
// of silently never matching an installation row.
const (
	CountdownBarID    = "countdown_bar"
	EmergencyAlertsID = "emergency_alerts"
	FormsID           = "forms"
	BrandBugID        = "brand_bug"
	NoiseMeterID      = "noise_meter"
)

// Definition is one release-owned plugin: what Tilecast can do, not whether an
// installation uses it. Every field is plain data. Nothing here is executed,
// downloaded, or supplied from outside the binary; Version is the definition
// contract this release implements, not a separately updated package.
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
	pluginIDPattern       = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)
	iconPattern           = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
	managementPathPattern = regexp.MustCompile(`^/[a-z0-9][a-z0-9/-]{0,119}$`)
	knownCategories       = map[string]bool{
		CategoryDisplay: true, CategoryAutomation: true, CategoryWorkflow: true, CategoryHardware: true,
	}
	knownRequirementKinds = map[string]bool{
		"platform": true, "hardware": true, "region": true, "network": true, "provider": true, "player": true,
	}
)

// registry lists every plugin this release can run, in catalog order.
var registry = []Definition{
	{
		ID: CountdownBarID, Version: 1, Name: "Countdown Bar",
		Description:          "Show a timed bottom bar without interrupting the content already playing.",
		Category:             CategoryDisplay,
		Icon:                 "clock",
		ManagementPath:       "/plugins/countdown-bar",
		InstanceNounSingular: "instance", InstanceNounPlural: "instances",
		Requirements: []Requirement{
			{Kind: "player", Label: "Player plugin support", Description: "Target screens need a Player build that renders plugin bars."},
		},
		Capabilities:  []string{"Player manifest plugin state", "Scheduled overlay bar"},
		Documentation: "docs/plugins.md#countdown-bar",
		Installable:   true,
	},
	{
		ID: EmergencyAlertsID, Version: 1, Name: "US Weather Alerts",
		Description:          "Watch official U.S. National Weather Service (NWS) alerts and respond automatically while one is active, with a fullscreen takeover or a ticker bar.",
		Category:             CategoryAutomation,
		Icon:                 "siren",
		ManagementPath:       "/plugins/emergency-alerts",
		InstanceNounSingular: "alert rule", InstanceNounPlural: "alert rules",
		Requirements: []Requirement{
			{Kind: "region", Label: "United States", Description: "National Weather Service alerts cover U.S. states, territories, and marine zones."},
			{Kind: "network", Label: "Internet access from Tilecast Server", Description: "The server polls api.weather.gov on a fixed interval."},
			{Kind: "provider", Label: "National Weather Service"},
		},
		Capabilities:  []string{"Background NWS polling", "Takeovers", "Player manifest plugin state"},
		Documentation: "docs/plugins.md#emergency-alerts",
		Installable:   true,
	},
	{
		ID: FormsID, Version: 1, Name: "Forms",
		Description:          "Collect submissions, run approval workflows, and publish approved records to Widgets.",
		Category:             CategoryWorkflow,
		Icon:                 "clipboard-list",
		ManagementPath:       "/plugins/forms",
		InstanceNounSingular: "form", InstanceNounPlural: "forms",
		Requirements:  []Requirement{},
		Capabilities:  []string{"Form Data Sources", "Approval workflows", "Record attachments"},
		Documentation: "docs/plugins.md#forms",
		Installable:   true,
	},
	{
		ID: BrandBugID, Version: 1, Name: "Brand Bug / Watermark",
		Description:          "Keep a logo, sponsor mark, legal notice, campaign badge, or location label in a corner over all normal content.",
		Category:             CategoryDisplay,
		Icon:                 "stamp",
		ManagementPath:       "/plugins/brand-bug",
		InstanceNounSingular: "mark", InstanceNounPlural: "marks",
		Requirements: []Requirement{
			{Kind: "player", Label: "Player plugin support", Description: "Target screens need a Player build that renders plugin overlays."},
		},
		Capabilities:  []string{"Player manifest plugin state", "Persistent corner overlay"},
		Documentation: "docs/plugins.md#brand-bug--watermark",
		Installable:   true,
	},
	{
		ID: NoiseMeterID, Version: 1, Name: "Noise Meter",
		Description:          "Watch room noise with a microphone on the Linux Player and show a bottom bar only while the room stays too loud.",
		Category:             CategoryHardware,
		Icon:                 "audio-lines",
		ManagementPath:       "/plugins/noise-meter",
		InstanceNounSingular: "meter", InstanceNounPlural: "meters",
		Requirements: []Requirement{
			{Kind: "platform", Label: "Linux Player"},
			{Kind: "hardware", Label: "Microphone or audio input", Description: "Audio is processed locally by the Player; samples are never uploaded."},
		},
		Capabilities:  []string{"Player microphone", "Player manifest plugin state", "Derived noise history"},
		Documentation: "docs/plugins.md#noise-meter",
		Installable:   true,
	},
}

func init() {
	if err := validateRegistry(registry); err != nil {
		panic(err)
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
		case !managementPathPattern.MatchString(d.ManagementPath) || strings.Contains(d.ManagementPath, "//"):
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
