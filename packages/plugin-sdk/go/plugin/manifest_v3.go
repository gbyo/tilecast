package plugin

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
)

// Plugin Manifest API 3 members. Version 3 keeps every shared member of
// versions 1 and 2 and the version 2 player contribution. It adds the
// declarations of docs/adr/plugin-model-v3.md phase 1: host-owned settings
// and instances described with the shared configuration schema, the
// personal-data marker on fields, and the Server services the plugin's
// typed client calls. Later phases add their own members.

// MaxInstanceKinds bounds the instance kinds of one plugin. Studio renders
// each kind as one tab of the plugin's page. Four is the most tabs Studio
// already shows in one tab list (the Widget inspector's four sections), and
// it fits a phone-width page without a scrolling tab list. Each kind also
// generates five API operations and five automation commands.
const MaxInstanceKinds = 4

// MaxSchemaFields bounds the fields of one settings scope or instance kind.
// It matches the component configuration bound of 64 keys.
const MaxSchemaFields = 64

// MaxServiceDeclarations bounds the services one plugin declares.
const MaxServiceDeclarations = 16

// Targeting modes of an instance kind.
const (
	// TargetingScreens: the instance names screens, groups, or locations and
	// the host projects it to those screens.
	TargetingScreens = "screens"
	// TargetingNone: the instance has no screen target and is never
	// projected to a Player.
	TargetingNone = "none"
)

// Schedule modes of an instance kind. The host decides when it projects an
// instance; a domain calendar stays plugin data.
const (
	ScheduleNone   = "none"
	ScheduleWindow = "window"
	ScheduleWeekly = "weekly"
)

// Priority bounds of an instance kind.
const (
	MinInstancePriority = -1000000
	MaxInstancePriority = 1000000
)

// ReservedInstanceKeys are the host members of an instance document. A
// field of an instance kind cannot use one as its key.
var ReservedInstanceKeys = set("id", "kind", "plugin", "name", "enabled", "priority", "targetScope", "targetIds",
	"schedule", "revision", "expectedRevision", "secrets", "clearSecrets", "createdAt", "updatedAt", "createdBy")

// Settings are the plugin's host-owned settings. The organization scope
// holds one value for each field; the screen scope holds one value for each
// field and screen. The instance scope is the field list of each instance
// kind.
type Settings struct {
	Organization []configschema.Field `json:"organization,omitempty"`
	Screen       []configschema.Field `json:"screen,omitempty"`
}

// InstanceKind is one kind of host-owned instance.
type InstanceKind struct {
	// Kind identifies the kind inside the plugin. It is stored with every
	// instance and never changes.
	Kind string       `json:"kind"`
	Noun InstanceNoun `json:"noun"`
	// Path is the URL segment below the plugin's API base path and Studio
	// route, for example "instances".
	Path string `json:"path"`
	// Operations name the generated OpenAPI operations:
	// list<Plural>, get<Singular>, create<Singular>, update<Singular>, and
	// delete<Singular>.
	Operations InstanceOperations `json:"operations"`
	Targeting  string             `json:"targeting"`
	Schedule   string             `json:"schedule"`
	// Priority, when present, gives each instance an integer priority. The
	// host projects instances strongest first.
	Priority *PriorityRange       `json:"priority,omitempty"`
	Fields   []configschema.Field `json:"fields"`
}

// InstanceOperations are the PascalCase names of the generated operations.
type InstanceOperations struct {
	Singular string `json:"singular"`
	Plural   string `json:"plural"`
}

// PriorityRange bounds an instance priority.
type PriorityRange struct {
	Minimum int `json:"minimum"`
	Maximum int `json:"maximum"`
	Default int `json:"default"`
}

var (
	kindPattern      = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	kindPathPattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
	operationPattern = regexp.MustCompile(`^[A-Z][A-Za-z0-9]{0,63}$`)
)

// reservedKindPaths are segments the host uses below a plugin's base path.
var reservedKindPaths = set("settings", "secrets", "status", "install", "kinds")

// InstanceKindByName returns a declared kind.
func (m Manifest) InstanceKindByName(kind string) (InstanceKind, bool) {
	for _, declared := range m.Instances {
		if declared.Kind == kind {
			return declared, true
		}
	}
	return InstanceKind{}, false
}

// HostOwnsInstances reports whether the host stores the plugin's instances.
func (m Manifest) HostOwnsInstances() bool {
	return m.APIVersion >= 3 && len(m.Instances) > 0
}

// APIBasePath is the first declared API base path, below which the host
// mounts generated routes. It is "" without an api declaration.
func (m Manifest) APIBasePath() string {
	if m.API == nil || len(m.API.BasePaths) == 0 {
		return ""
	}
	return m.API.BasePaths[0]
}

func (m Manifest) validateV3() error {
	if m.Capabilities.PlayerManifest {
		return fmt.Errorf("capabilities.playerManifest is a Plugin API 1 member; declare player.state instead")
	}
	if len(m.Capabilities.Network) > 0 {
		return fmt.Errorf("capabilities.network is not a Plugin Manifest API 3 member; outbound access arrives with host connections")
	}
	if m.Runtime != nil {
		return fmt.Errorf("runtime is a Plugin API 1 member; declare a player contribution instead")
	}
	if err := m.Player.validate(); err != nil {
		return err
	}
	if len(m.Services) > MaxServiceDeclarations {
		return fmt.Errorf("services needs at most %d declarations", MaxServiceDeclarations)
	}
	seenServices := map[string]bool{}
	for _, value := range m.Services {
		reference, ok := ParseServiceReference(value)
		if !ok {
			return fmt.Errorf("invalid service reference %q; use name@version", value)
		}
		if seenServices[reference.Name] {
			return fmt.Errorf("service %s is declared twice", reference.Name)
		}
		seenServices[reference.Name] = true
		if _, ok := LookupServerService(reference.Name, reference.Version); !ok {
			return fmt.Errorf("service %s is not a Server service a bundled plugin can call", value)
		}
	}
	if m.Settings != nil {
		for _, scope := range []struct {
			name   string
			fields []configschema.Field
		}{{"organization", m.Settings.Organization}, {"screen", m.Settings.Screen}} {
			if err := validatePluginFields("settings."+scope.name, scope.fields); err != nil {
				return err
			}
		}
	}
	if len(m.Instances) > MaxInstanceKinds {
		return fmt.Errorf("instances declares %d kinds; the limit is %d", len(m.Instances), MaxInstanceKinds)
	}
	kinds, paths, operations := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, kind := range m.Instances {
		if !kindPattern.MatchString(kind.Kind) {
			return fmt.Errorf("invalid instance kind %q", kind.Kind)
		}
		if kinds[kind.Kind] {
			return fmt.Errorf("instance kind %q is declared twice", kind.Kind)
		}
		kinds[kind.Kind] = true
		if err := bounded("instance noun singular", kind.Noun.Singular, 40); err != nil {
			return err
		}
		if err := bounded("instance noun plural", kind.Noun.Plural, 40); err != nil {
			return err
		}
		if !kindPathPattern.MatchString(kind.Path) || reservedKindPaths[kind.Path] {
			return fmt.Errorf("instance kind %q has an invalid or reserved path %q", kind.Kind, kind.Path)
		}
		if paths[kind.Path] {
			return fmt.Errorf("instance path %q is declared twice", kind.Path)
		}
		paths[kind.Path] = true
		for _, name := range []string{kind.Operations.Singular, kind.Operations.Plural} {
			if !operationPattern.MatchString(name) {
				return fmt.Errorf("instance kind %q has an invalid operation name %q", kind.Kind, name)
			}
		}
		if kind.Operations.Singular == kind.Operations.Plural || operations[kind.Operations.Singular] || operations[kind.Operations.Plural] {
			return fmt.Errorf("instance kind %q repeats an operation name", kind.Kind)
		}
		operations[kind.Operations.Singular], operations[kind.Operations.Plural] = true, true
		switch kind.Targeting {
		case TargetingScreens, TargetingNone:
		default:
			return fmt.Errorf("instance kind %q has unknown targeting %q", kind.Kind, kind.Targeting)
		}
		switch kind.Schedule {
		case ScheduleNone:
		case ScheduleWindow, ScheduleWeekly:
			if kind.Targeting != TargetingScreens {
				return fmt.Errorf("instance kind %q has a %s schedule but no screen targeting; the host schedules only what it projects", kind.Kind, kind.Schedule)
			}
		default:
			return fmt.Errorf("instance kind %q has unknown schedule %q", kind.Kind, kind.Schedule)
		}
		if priority := kind.Priority; priority != nil {
			if priority.Minimum < MinInstancePriority || priority.Maximum > MaxInstancePriority ||
				priority.Minimum > priority.Default || priority.Default > priority.Maximum {
				return fmt.Errorf("instance kind %q has an invalid priority range", kind.Kind)
			}
		}
		if err := validatePluginFields("instances."+kind.Kind, kind.Fields); err != nil {
			return err
		}
		for _, field := range kind.Fields {
			if ReservedInstanceKeys[field.Key] {
				return fmt.Errorf("instance kind %q field %q uses a key the host owns", kind.Kind, field.Key)
			}
		}
	}
	if len(m.Instances) > 0 {
		if m.API == nil {
			return fmt.Errorf("instances need api.basePaths: the host mounts their routes below the first base path")
		}
		if m.Studio == nil {
			return fmt.Errorf("instances need a studio route: the host mounts their pages there")
		}
	}
	return nil
}

// validatePluginFields checks one API 3 field list: the shared schema rules
// for the plugin profile, the bound on fields, and the rules this release
// adds because their runtime does not exist yet.
func validatePluginFields(where string, fields []configschema.Field) error {
	if len(fields) > MaxSchemaFields {
		return fmt.Errorf("%s declares %d fields; the limit is %d", where, len(fields), MaxSchemaFields)
	}
	if err := configschema.ValidateFields(fields, configschema.ProfilePlugin); err != nil {
		return fmt.Errorf("%s: %v", where, err)
	}
	var walk func([]configschema.Field) error
	walk = func(fields []configschema.Field) error {
		for _, field := range fields {
			if field.Control == configschema.ControlConnection {
				return fmt.Errorf("%s field %q is a connection; host connections arrive in a later Plugin Model V3 phase", where, field.Key)
			}
			if field.Personal != nil && field.Required {
				// The host removes a personal value when its retention ends.
				// A required value could not be removed without making the
				// stored document invalid.
				return fmt.Errorf("%s field %q is personal and required; a personal value must be removable when its retention ends", where, field.Key)
			}
			if field.Control == "data_source" || field.Control == "data_source_field" {
				return fmt.Errorf("%s field %q uses a Data Source control, which plugin settings do not support yet", where, field.Key)
			}
			if field.Control == "repeating_group" {
				for _, item := range field.ItemFields {
					if item.Personal != nil {
						return fmt.Errorf("%s field %q holds a personal field; personal fields are top-level until per-record retention exists", where, field.Key)
					}
				}
				if err := walk(field.ItemFields); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(fields)
}

// PersonalFields lists every personal field the manifest declares, keyed
// by "settings.organization.<path>", "settings.screen.<path>", or
// "instances.<kind>.<path>".
func (m Manifest) PersonalFields() map[string]configschema.Personal {
	out := map[string]configschema.Personal{}
	add := func(prefix string, fields []configschema.Field) {
		for path, personal := range configschema.PersonalFields(fields) {
			out[prefix+path] = personal
		}
	}
	if m.Settings != nil {
		add("settings.organization.", m.Settings.Organization)
		add("settings.screen.", m.Settings.Screen)
	}
	for _, kind := range m.Instances {
		add("instances."+kind.Kind+".", kind.Fields)
	}
	return out
}

// OperationID returns a generated operation identifier for a kind.
func (k InstanceKind) OperationID(verb string) string {
	switch verb {
	case "list":
		return "list" + k.Operations.Plural
	default:
		return strings.ToLower(verb) + k.Operations.Singular
	}
}
