package playlists

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// ManifestSchemaComponents is the first manifest schema that carries kind
// "component" Widget presentations (docs/widgets-v2.md). It includes every
// v15 feature; v11–v15 keep their meaning.
const ManifestSchemaComponents = 16

// ComponentPresentation references a first-class Widget component. Prepared
// Data Documents stay in the manifest's dataSources; the component lists only
// which of them, and which media variants, it may read.
type ComponentPresentation struct {
	Type        string              `json:"type"`
	Version     int                 `json:"version"`
	Config      map[string]any      `json:"config"`
	DataSources []string            `json:"dataSources"`
	Media       []ComponentMediaRef `json:"media"`
}

type ComponentMediaRef struct {
	AssetID   string `json:"assetId"`
	VariantID string `json:"variantId"`
}

// compileWidgetComponent returns a Widget's component presentation, or nil
// when its definition has no component. It never replaces the compatibility
// presentation: manifest generation chooses between them for each Player.
func (s *Service) compileWidgetComponent(provider string, raw json.RawMessage) (*WidgetPresentation, error) {
	definition, ok := s.definitions.Widget(provider)
	if !ok || definition.Component == nil {
		return nil, nil
	}
	spec := *definition.Component
	configuration := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &configuration); err != nil {
			return nil, err
		}
	}
	config, err := contentdefs.CompileComponentConfig(spec, configuration)
	if err != nil {
		return nil, fmt.Errorf("compile %s component: %w", provider, err)
	}
	dataSources := []string{}
	grant := func(value string) {
		id, parseErr := uuid.Parse(value)
		if parseErr != nil || id == uuid.Nil {
			return
		}
		if !containsString(dataSources, id.String()) {
			dataSources = append(dataSources, id.String())
		}
	}
	for _, key := range spec.DataSourceFields {
		value, _ := configuration[key].(string)
		grant(value)
	}
	if definition.Recipe != nil {
		// An App recipe's author schema intentionally hides its managed
		// source, so no declared data_source control names it. The compiled
		// configuration still carries the explicit relationship, exactly as
		// manifest dependency resolution and Studio preview grants read it.
		managed, _ := configuration["managedDataSourceId"].(string)
		grant(managed)
	}
	return &WidgetPresentation{
		SchemaVersion:        contentdefs.ComponentPresentationSchemaVersion,
		Kind:                 "component",
		RequiredCapabilities: map[string]int{spec.Capability(): spec.Version},
		Component: &ComponentPresentation{
			Type: spec.Type, Version: spec.Version, Config: config,
			DataSources: dataSources, Media: []ComponentMediaRef{},
		},
	}, nil
}

// presentationSupported reports whether a Player that reported its
// capabilities renders a presentation, and the sorted capability names.
func presentationSupported(presentation *WidgetPresentation, player playerPresentationCapabilities) (bool, []string) {
	capabilities := make([]string, 0, len(presentation.RequiredCapabilities))
	for capability := range presentation.RequiredCapabilities {
		capabilities = append(capabilities, capability)
	}
	sort.Strings(capabilities)
	if !player.Reported {
		return false, capabilities
	}
	hasSchema := false
	for _, version := range player.SchemaVersions {
		if int(version) == presentation.SchemaVersion {
			hasSchema = true
			break
		}
	}
	if !hasSchema {
		return false, capabilities
	}
	for _, capability := range capabilities {
		reported := player.Native[capability]
		if capability == "web.remote" {
			reported = player.WebRuntime
		}
		if reported < presentation.RequiredCapabilities[capability] {
			return false, capabilities
		}
	}
	return true, capabilities
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
