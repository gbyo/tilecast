package contentdefs

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/tilecast/tilecast/widgets"
)

// Widgets V2 (docs/widgets-v2.md). A Widget module below widgets/ carries its
// catalog definition and its first-class component in one tilecast.widget.json.
// The identity rules below mirror packages/widget-sdk/src/identity.ts.

const (
	// ComponentPresentationSchemaVersion is the newest presentation schema of
	// kind "component" presentations. Schema 3 carries the declared empty
	// policy; native and web presentations use schema 1.
	ComponentPresentationSchemaVersion = 3
	maxComponentVersion                = 100
	// maxWidgetCapabilityLen is the heartbeat's capability-name bound. The
	// full "widget.<type>" capability must fit within it.
	maxWidgetCapabilityLen   = 80
	maxComponentConfigBytes  = 8 * 1024
	maxComponentConfigDepth  = 6
	maxComponentConfigKeys   = 64
	maxComponentConfigItems  = 200
	maxComponentConfigString = 2000
	maxComponentDataSources  = 8
	tilecastTagPrefix        = "tc-widget-"
)

var (
	componentTypePattern = regexp.MustCompile(`^[a-z][a-z0-9]{1,31}(\.[a-z][a-z0-9-]{0,47})+$`)
	componentTagPattern  = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)+$`)
)

// ComponentSpec describes a Widget's first-class component.
type ComponentSpec struct {
	Type    string `json:"type"`
	Version int    `json:"version"`
	TagName string `json:"tagName"`
	// Entrypoint is the module inside the Widget directory that default-exports
	// defineWidget(...). It is compiled into the Player Runtime and Studio.
	Entrypoint string `json:"entrypoint"`
	// ConfigTemplate compiles the persisted Widget configuration into the
	// component configuration with the closed {"$config": key, "default": v} form.
	ConfigTemplate json.RawMessage `json:"configTemplate"`
	// DataSourceFields are configuration keys that hold Data Source IDs the
	// component may read.
	DataSourceFields []string `json:"dataSourceFields,omitempty"`
	Empty            string   `json:"empty"`
}

// Compatibility says how Players without the component render the Widget.
type Compatibility struct {
	// Fallback is "legacy" (the Server's built-in compiler for the provider),
	// "template" (the definition's presentation template) or "none".
	Fallback string `json:"fallback"`
}

// Capability is the name a Player reports for a component it can render.
func (spec ComponentSpec) Capability() string { return "widget." + spec.Type }

// HasFallback reports whether Players without the component can still render
// the Widget through its compatibility presentation.
func (definition WidgetDefinition) HasFallback() bool {
	return definition.Compatibility == nil || definition.Compatibility.Fallback != "none"
}

// decodeWidgetManifest decodes one Widget manifest into a definition with
// its discovery source. The manifest beside the Widget cannot declare its
// own source: a manifest carrying a source is rejected, so a file can never
// lie about whether it is core- or plugin-owned.
func decodeWidgetManifest(dir string, raw []byte, source ExtensionSource) (WidgetDefinition, error) {
	var definition WidgetDefinition
	if err := json.Unmarshal(raw, &definition); err != nil {
		return WidgetDefinition{}, fmt.Errorf("%s/%s: %w", dir, widgets.ManifestFile, err)
	}
	if definition.Source != (ExtensionSource{}) {
		return WidgetDefinition{}, fmt.Errorf("%s: a Widget manifest must not declare its own source", dir)
	}
	if definition.Component == nil || definition.Compatibility == nil {
		return WidgetDefinition{}, fmt.Errorf("%s: a Widget module must declare component and compatibility", dir)
	}
	definition.Source = source
	return definition, nil
}

// loadWidgetModules decodes every embedded Widget manifest into a
// definition: root widgets/ modules as core, then the generated
// plugin-owned ledger (widgets/plugin_widgets.gen.go) with each owning
// plugin's stable tilecast.plugin.json id.
func loadWidgetModules() ([]WidgetDefinition, [][]byte, error) {
	manifests, err := widgets.Manifests()
	if err != nil {
		return nil, nil, err
	}
	pluginManifests := widgets.PluginWidgetManifests()
	definitions := make([]WidgetDefinition, 0, len(manifests)+len(pluginManifests))
	raws := make([][]byte, 0, len(manifests)+len(pluginManifests))
	for _, manifest := range manifests {
		definition, err := decodeWidgetManifest("widgets/"+manifest.Dir, manifest.JSON, CoreSource())
		if err != nil {
			return nil, nil, err
		}
		definitions = append(definitions, definition)
		raws = append(raws, manifest.JSON)
	}
	for _, manifest := range pluginManifests {
		definition, err := decodeWidgetManifest(manifest.Dir, []byte(manifest.JSON), PluginSource(manifest.PluginID))
		if err != nil {
			return nil, nil, err
		}
		definitions = append(definitions, definition)
		raws = append(raws, []byte(manifest.JSON))
	}
	return definitions, raws, nil
}

func validateComponent(definition WidgetDefinition) error {
	spec := definition.Component
	if spec == nil {
		if definition.Compatibility != nil {
			return errors.New("compatibility is declared without a component")
		}
		return nil
	}
	if definition.APIVersion != 1 {
		return fmt.Errorf("Widget manifest apiVersion must be 1")
	}
	if !componentTypePattern.MatchString(spec.Type) {
		return fmt.Errorf("component type %q must be a qualified identity", spec.Type)
	}
	if len(spec.Capability()) > maxWidgetCapabilityLen {
		return fmt.Errorf("component capability %q is longer than %d characters", spec.Capability(), maxWidgetCapabilityLen)
	}
	if spec.Version < 1 || spec.Version > maxComponentVersion {
		return fmt.Errorf("component version must be from 1 to %d", maxComponentVersion)
	}
	if !componentTagPattern.MatchString(spec.TagName) {
		return fmt.Errorf("component tag %q is not a custom-element name", spec.TagName)
	}
	if name, ok := strings.CutPrefix(spec.Type, "tilecast."); ok && spec.TagName != tilecastTagPrefix+strings.ReplaceAll(name, ".", "-") {
		return fmt.Errorf("component tag must be %s%s", tilecastTagPrefix, strings.ReplaceAll(name, ".", "-"))
	}
	if spec.Entrypoint != "./runtime/index.ts" {
		return errors.New("component entrypoint must be ./runtime/index.ts")
	}
	if spec.Empty != "render" && spec.Empty != "skip-eligible" {
		return errors.New("component empty behavior must be render or skip-eligible")
	}
	var template map[string]any
	if err := json.Unmarshal(spec.ConfigTemplate, &template); err != nil || template == nil {
		return errors.New("component configTemplate must be an object")
	}
	if err := validateConfigTemplate(template, 1); err != nil {
		return err
	}
	if len(spec.DataSourceFields) > maxComponentDataSources {
		return errors.New("component declares too many Data Source fields")
	}
	fields := map[string]FieldDefinition{}
	for _, field := range definition.ConfigurationSchema.Fields {
		fields[field.Key] = field
	}
	for _, key := range spec.DataSourceFields {
		field, declared := fields[key]
		// Legacy-editor Widgets have no generated schema; their persisted
		// configuration names the Data Source directly (for example dataSourceId).
		if declared && field.Control != "data_source" || !declared && !definition.LegacyEditor {
			return fmt.Errorf("component Data Source field %q is not a data_source control", key)
		}
	}
	if definition.Compatibility == nil {
		return errors.New("a component requires a compatibility declaration")
	}
	switch definition.Compatibility.Fallback {
	case "legacy":
		if !definition.LegacyEditor {
			return errors.New("legacy fallback requires legacyEditor")
		}
	case "template":
		if len(definition.PresentationTemplate) == 0 {
			return errors.New("template fallback requires presentationTemplate")
		}
	case "none":
	default:
		return errors.New("compatibility fallback must be legacy, template or none")
	}
	return nil
}

// validateConfigTemplate accepts plain JSON and
// {"$config": key[, "default": v][, "when": flag]}.
func validateConfigTemplate(value any, depth int) error {
	if depth > maxComponentConfigDepth {
		return errors.New("component configTemplate is too deep")
	}
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if err := validateConfigTemplate(item, depth+1); err != nil {
				return err
			}
		}
	case map[string]any:
		if key, ok := typed["$config"]; ok {
			if name, isString := key.(string); !isString || name == "" {
				return errors.New(`component configTemplate "$config" must name a key`)
			}
			for field := range typed {
				if field != "$config" && field != "default" && field != "when" {
					return fmt.Errorf("component configTemplate reference has unknown key %q", field)
				}
			}
			if flag, hasWhen := typed["when"]; hasWhen {
				if name, isString := flag.(string); !isString || name == "" {
					return errors.New(`component configTemplate "when" must name a key`)
				}
			}
			return nil
		}
		for key, item := range typed {
			if strings.HasPrefix(key, "$") {
				return fmt.Errorf("component configTemplate uses unsupported directive %q", key)
			}
			if err := validateConfigTemplate(item, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

// CompileComponentConfig compiles a persisted Widget configuration into the
// component configuration. It mirrors compileComponentConfig in
// packages/widget-sdk/src/manifest.ts; the Widget fixtures keep them in step.
func CompileComponentConfig(spec ComponentSpec, configuration map[string]any) (map[string]any, error) {
	var template any
	if err := json.Unmarshal(spec.ConfigTemplate, &template); err != nil {
		return nil, err
	}
	resolved, err := resolveComponentTemplate(template, configuration)
	if err != nil {
		return nil, err
	}
	config, ok := resolved.(map[string]any)
	if !ok {
		return nil, errors.New("component configuration must be an object")
	}
	if err := ComponentConfigLimitProblem(config); err != nil {
		return nil, err
	}
	return config, nil
}

// configFlagOn reports whether a "when" gate permits $config resolution.
// A missing gate always permits; an explicit false, empty string, or zero
// resolves the default instead, so legacy toggles like showBody keep their
// meaning when a persisted configuration projects into a V2 component.
func configFlagOn(value any) bool {
	switch gated := value.(type) {
	case nil:
		return false
	case bool:
		return gated
	case string:
		return gated != ""
	case float64:
		return gated != 0
	default:
		return true
	}
}

func resolveComponentTemplate(value any, configuration map[string]any) (any, error) {
	switch typed := value.(type) {
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			resolved, err := resolveComponentTemplate(item, configuration)
			if err != nil {
				return nil, err
			}
			out = append(out, resolved)
		}
		return out, nil
	case map[string]any:
		if key, ok := typed["$config"].(string); ok {
			if flag, hasWhen := typed["when"].(string); hasWhen && flag != "" {
				if gated, exists := configuration[flag]; exists && !configFlagOn(gated) {
					if fallback, hasDefault := typed["default"]; hasDefault {
						return resolveComponentTemplate(fallback, configuration)
					}
					return "", nil
				}
			}
			if resolved, exists := configuration[key]; exists {
				return resolved, nil
			}
			if fallback, exists := typed["default"]; exists {
				// A default may itself reference configuration, so a
				// compatibility definition can prefer its current keys and
				// fall back to the legacy keys it supersedes.
				return resolveComponentTemplate(fallback, configuration)
			}
			return nil, fmt.Errorf("component configTemplate references missing configuration %q", key)
		}
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			resolved, err := resolveComponentTemplate(item, configuration)
			if err != nil {
				return nil, err
			}
			out[key] = resolved
		}
		return out, nil
	default:
		return value, nil
	}
}

// ComponentConfigLimitProblem enforces the component configuration bounds of
// docs/widgets-v2.md §6.
func ComponentConfigLimitProblem(config map[string]any) error {
	encoded, err := json.Marshal(config)
	if err != nil {
		return err
	}
	if len(encoded) > maxComponentConfigBytes {
		return fmt.Errorf("component configuration exceeds %d bytes", maxComponentConfigBytes)
	}
	var visit func(any, int) error
	visit = func(value any, depth int) error {
		if depth > maxComponentConfigDepth {
			return errors.New("component configuration is too deep")
		}
		switch typed := value.(type) {
		case string:
			if len([]rune(typed)) > maxComponentConfigString {
				return errors.New("component configuration contains an oversized string")
			}
		case []any:
			if len(typed) > maxComponentConfigItems {
				return errors.New("component configuration contains an oversized array")
			}
			for _, item := range typed {
				if err := visit(item, depth+1); err != nil {
					return err
				}
			}
		case map[string]any:
			if len(typed) > maxComponentConfigKeys {
				return errors.New("component configuration contains an oversized object")
			}
			for _, item := range typed {
				if err := visit(item, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return visit(config, 1)
}
