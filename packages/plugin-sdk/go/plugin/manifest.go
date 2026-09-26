package plugin

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// APIVersion is the Tilecast Plugin API this SDK implements. A manifest whose
// apiVersion this release does not support is rejected at build time by
// pluginctl and at startup by the host.
const APIVersion = 1

// SupportedAPIVersions lists the Plugin API versions this release can load.
var SupportedAPIVersions = []int{1}

// Manifest is a parsed tilecast.plugin.json. It mirrors the Zod schema in
// packages/plugin-sdk/src/manifest.ts; the shared fixtures in
// packages/plugin-sdk/testdata/manifests keep both parsers in agreement.
type Manifest struct {
	Schema            string        `json:"$schema,omitempty"`
	APIVersion        int           `json:"apiVersion"`
	ID                string        `json:"id"`
	DefinitionVersion int           `json:"definitionVersion"`
	Name              string        `json:"name"`
	Description       string        `json:"description"`
	Category          string        `json:"category"`
	Icon              string        `json:"icon"`
	Maintainers       []string      `json:"maintainers"`
	Installable       *bool         `json:"installable,omitempty"`
	InstanceNoun      InstanceNoun  `json:"instanceNoun"`
	Requirements      []Requirement `json:"requirements,omitempty"`
	Uses              []string      `json:"uses,omitempty"`
	Capabilities      Capabilities  `json:"capabilities"`
	Server            *ServerEntry  `json:"server,omitempty"`
	Migrations        string        `json:"migrations,omitempty"`
	API               *APIEntry     `json:"api,omitempty"`
	Studio            *StudioEntry  `json:"studio,omitempty"`
	Runtime           *RuntimeEntry `json:"runtime,omitempty"`
	Docs              *DocsEntry    `json:"docs,omitempty"`
}

type InstanceNoun struct {
	Singular string `json:"singular"`
	Plural   string `json:"plural"`
}

// Requirement is advice shown before installation. It is never evaluated: a
// requirement a site cannot meet produces advice, not a refusal.
type Requirement struct {
	Kind        string `json:"kind"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// Capabilities are machine-readable declarations. The host checks each
// contribution a plugin implements against them, so a plugin cannot, for
// example, run a background worker it never declared.
type Capabilities struct {
	PlayerManifest    bool     `json:"playerManifest,omitempty"`
	BackgroundWorkers bool     `json:"backgroundWorkers,omitempty"`
	Network           []string `json:"network,omitempty"`
	Hardware          []string `json:"hardware,omitempty"`
	Heartbeat         []string `json:"heartbeat,omitempty"`
}

type ServerEntry struct {
	Entrypoint string `json:"entrypoint"`
}

type APIEntry struct {
	BasePaths []string `json:"basePaths"`
	OpenAPI   string   `json:"openapi,omitempty"`
}

type StudioEntry struct {
	Route      string `json:"route"`
	Entrypoint string `json:"entrypoint"`
}

type RuntimeEntry struct {
	Entrypoint    string   `json:"entrypoint"`
	ManifestTypes []string `json:"manifestTypes"`
	Surfaces      []string `json:"surfaces,omitempty"`
}

type DocsEntry struct {
	Reference string    `json:"reference,omitempty"`
	Pages     []DocPage `json:"pages,omitempty"`
}

type DocPage struct {
	Source  string       `json:"source"`
	Slug    string       `json:"slug"`
	Label   string       `json:"label,omitempty"`
	Sidebar *DocsSidebar `json:"sidebar,omitempty"`
}

// DocsSidebar places a public docs page in one of the docs site's plugin
// sidebar groups.
type DocsSidebar struct {
	Group string `json:"group,omitempty"`
	Badge string `json:"badge,omitempty"`
}

// IsInstallable reports the manifest's installable flag, which defaults to true.
func (m Manifest) IsInstallable() bool {
	return m.Installable == nil || *m.Installable
}

// StudioRoute is the Studio route that manages the plugin, or "" when the
// plugin has no Studio pages.
func (m Manifest) StudioRoute() string {
	if m.Studio == nil {
		return ""
	}
	return m.Studio.Route
}

// ManifestTypes lists the Player manifest entry types the plugin projects.
func (m Manifest) ManifestTypes() []string {
	if m.Runtime == nil {
		return nil
	}
	return append([]string(nil), m.Runtime.ManifestTypes...)
}

// Conventional entry points. Each build finds plugin code by these fixed
// paths (the Go registry generator, and Vite import.meta.glob for Studio and
// the Player runtime), so a manifest may only name the path the build
// actually discovers.
const (
	ServerEntrypoint  = "./plugin.go"
	StudioEntrypoint  = "./studio/index.tsx"
	RuntimeEntrypoint = "./runtime/index.ts"
)

var (
	IDPattern         = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)
	iconPattern       = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
	routePattern      = regexp.MustCompile(`^/[a-z0-9][a-z0-9/-]{0,119}$`)
	slugPattern       = regexp.MustCompile(`^[a-z0-9][a-z0-9/-]{0,119}$`)
	pathPattern       = regexp.MustCompile(`^\.(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$`)
	maintainerPattern = regexp.MustCompile(`^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$`)
	hostnamePattern   = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
	heartbeatPattern  = regexp.MustCompile(`^[a-z][A-Za-z0-9]{0,39}$`)

	categories       = set("Display", "Automation", "Workflow", "Hardware")
	requirementKinds = set("platform", "hardware", "region", "network", "provider", "player")
	surfaceSlots     = set("strip.top", "strip.bottom", "corner.top-left", "corner.top-right",
		"corner.bottom-left", "corner.bottom-right", "overlay")
	hardware      = set("microphone")
	sidebarGroups = set("plugins", "review-and-collect")
)

// ParseManifest decodes and validates a tilecast.plugin.json. Unknown fields
// are rejected so a misspelled declaration fails the build rather than being
// ignored.
func ParseManifest(data []byte) (Manifest, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("plugin manifest: %w", err)
	}
	if decoder.More() {
		return Manifest{}, errors.New("plugin manifest: trailing data")
	}
	if err := manifest.Validate(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// Validate checks every rule the JSON Schema expresses.
func (m Manifest) Validate() error {
	fail := func(format string, args ...any) error {
		id := m.ID
		if id == "" {
			id = "<unnamed>"
		}
		return fmt.Errorf("plugin manifest %s: %s", id, fmt.Sprintf(format, args...))
	}
	if !contains(SupportedAPIVersions, m.APIVersion) {
		return fail("apiVersion %d is not supported by this release", m.APIVersion)
	}
	if !IDPattern.MatchString(m.ID) {
		return fail("invalid id")
	}
	if m.DefinitionVersion < 1 {
		return fail("definitionVersion must be positive")
	}
	if err := bounded("name", m.Name, 80); err != nil {
		return fail("%v", err)
	}
	if err := bounded("description", m.Description, 280); err != nil {
		return fail("%v", err)
	}
	if !categories[m.Category] {
		return fail("unknown category %q", m.Category)
	}
	if !iconPattern.MatchString(m.Icon) {
		return fail("invalid icon %q", m.Icon)
	}
	if len(m.Maintainers) == 0 {
		return fail("at least one maintainer is required")
	}
	for _, maintainer := range m.Maintainers {
		if !maintainerPattern.MatchString(maintainer) {
			return fail("invalid maintainer %q", maintainer)
		}
	}
	if err := bounded("instanceNoun.singular", m.InstanceNoun.Singular, 40); err != nil {
		return fail("%v", err)
	}
	if err := bounded("instanceNoun.plural", m.InstanceNoun.Plural, 40); err != nil {
		return fail("%v", err)
	}
	for _, requirement := range m.Requirements {
		if !requirementKinds[requirement.Kind] {
			return fail("unknown requirement kind %q", requirement.Kind)
		}
		if err := bounded("requirement label", requirement.Label, 80); err != nil {
			return fail("%v", err)
		}
		if requirement.Description != "" {
			if err := bounded("requirement description", requirement.Description, 280); err != nil {
				return fail("%v", err)
			}
		}
	}
	for _, use := range m.Uses {
		if err := bounded("uses entry", use, 80); err != nil {
			return fail("%v", err)
		}
	}
	for _, host := range m.Capabilities.Network {
		if len(host) > 253 || !hostnamePattern.MatchString(host) {
			return fail("invalid network host %q", host)
		}
	}
	for _, item := range m.Capabilities.Hardware {
		if !hardware[item] {
			return fail("unknown hardware capability %q", item)
		}
	}
	for _, section := range m.Capabilities.Heartbeat {
		if !heartbeatPattern.MatchString(section) {
			return fail("invalid heartbeat section %q", section)
		}
	}
	checkPath := func(field, value string) error {
		if !pathPattern.MatchString(value) {
			return fail("%s must be a ./relative path inside the plugin directory", field)
		}
		return nil
	}
	conventional := func(field, value, want string) error {
		if value != want {
			return fail("%s must be %s", field, want)
		}
		return nil
	}
	if m.Server != nil {
		if err := conventional("server.entrypoint", m.Server.Entrypoint, ServerEntrypoint); err != nil {
			return err
		}
	}
	if m.Migrations != "" {
		if err := checkPath("migrations", m.Migrations); err != nil {
			return err
		}
	}
	if m.API != nil {
		if len(m.API.BasePaths) == 0 {
			return fail("api.basePaths needs at least one path")
		}
		for _, base := range m.API.BasePaths {
			if !routePattern.MatchString(base) || strings.Contains(base, "//") {
				return fail("invalid api base path %q", base)
			}
		}
		if m.API.OpenAPI != "" {
			if err := checkPath("api.openapi", m.API.OpenAPI); err != nil {
				return err
			}
		}
	}
	if m.Studio != nil {
		if !routePattern.MatchString(m.Studio.Route) || strings.Contains(m.Studio.Route, "//") {
			return fail("invalid studio route %q", m.Studio.Route)
		}
		if err := conventional("studio.entrypoint", m.Studio.Entrypoint, StudioEntrypoint); err != nil {
			return err
		}
	}
	if m.Runtime != nil {
		if err := conventional("runtime.entrypoint", m.Runtime.Entrypoint, RuntimeEntrypoint); err != nil {
			return err
		}
		if len(m.Runtime.ManifestTypes) == 0 {
			return fail("runtime.manifestTypes needs at least one type")
		}
		for _, kind := range m.Runtime.ManifestTypes {
			if !IDPattern.MatchString(kind) {
				return fail("invalid runtime manifest type %q", kind)
			}
		}
		for _, slot := range m.Runtime.Surfaces {
			if !surfaceSlots[slot] {
				return fail("unknown runtime surface %q", slot)
			}
		}
	}
	if m.Docs != nil {
		if len(m.Docs.Reference) > 200 {
			return fail("docs.reference is too long")
		}
		for _, page := range m.Docs.Pages {
			if err := checkPath("docs.pages.source", page.Source); err != nil {
				return err
			}
			if !slugPattern.MatchString(page.Slug) {
				return fail("invalid docs slug %q", page.Slug)
			}
			if page.Label != "" {
				if err := bounded("docs label", page.Label, 80); err != nil {
					return fail("%v", err)
				}
			}
			if page.Sidebar != nil {
				if page.Sidebar.Group != "" && !sidebarGroups[page.Sidebar.Group] {
					return fail("unknown docs sidebar group %q", page.Sidebar.Group)
				}
				if page.Sidebar.Badge != "" {
					if err := bounded("docs badge", page.Sidebar.Badge, 12); err != nil {
						return fail("%v", err)
					}
				}
			}
		}
	}
	return nil
}

func bounded(field, value string, max int) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len([]rune(trimmed)) > max {
		return fmt.Errorf("%s must be 1-%d characters", field, max)
	}
	return nil
}

func set(values ...string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		out[value] = true
	}
	return out
}

func contains(values []int, value int) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
