package playlists

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

const (
	// ManifestSchemaComponents first carries kind "component" Widget
	// presentations with component presentation schema 2.
	ManifestSchemaComponents = 16
	// ManifestSchemaComponentEmptyPolicy carries component presentation schema 3.
	ManifestSchemaComponentEmptyPolicy = 17
	// ManifestSchemaExternalComponents carries external Widget components:
	// schema 3 components with a package block naming the verified
	// package digest and the player bundle download. It includes every
	// v17 feature.
	ManifestSchemaExternalComponents  = 18
	componentPresentationSchemaLegacy = 2
)

// ComponentPresentation references a first-class Widget component. Prepared
// Data Documents stay in the manifest's dataSources; the component lists only
// which of them, and which media variants, it may read.
type ComponentPresentation struct {
	Type        string              `json:"type"`
	Version     int                 `json:"version"`
	Config      map[string]any      `json:"config"`
	DataSources []string            `json:"dataSources"`
	Media       []ComponentMediaRef `json:"media"`
	Empty       string              `json:"empty,omitempty"`
	// Package names the installed package supplying an external
	// component: its identity, verified digest, and bundle download.
	// It is nil for release components, which Players already bundle.
	Package *ExternalPackageRef `json:"package,omitempty"`
}

// ExternalPackageRef is the verified download claim for one external
// Widget component: which package, which pinned artifact digest, and
// the bundle hash, size, and player-authenticated download path the
// Player verifies before activation.
type ExternalPackageRef struct {
	PackageID    string `json:"packageId"`
	Digest       string `json:"digest"`
	SHA256       string `json:"sha256"`
	FileSize     int64  `json:"fileSize"`
	DownloadPath string `json:"downloadPath"`
}

type ComponentMediaRef struct {
	AssetID   string `json:"assetId"`
	VariantID string `json:"variantId"`
}

// compileWidgetComponent returns a Widget's component presentation, or nil
// when the component cannot preserve a saved behavior. Manifest generation
// then uses the compatibility presentation when one exists.
func (s *Service) compileWidgetComponent(provider string, raw json.RawMessage) (*WidgetPresentation, error) {
	return s.compileWidgetComponentForSchema(provider, raw, contentdefs.ComponentPresentationSchemaVersion)
}

func (s *Service) compileWidgetComponentForSchema(provider string, raw json.RawMessage, schemaVersion int) (*WidgetPresentation, error) {
	if schemaVersion != componentPresentationSchemaLegacy && schemaVersion != contentdefs.ComponentPresentationSchemaVersion {
		return nil, fmt.Errorf("unsupported component presentation schema %d", schemaVersion)
	}
	definition, ok := s.definitions.Widget(provider)
	if !ok || definition.Component == nil {
		return nil, nil
	}
	spec := *definition.Component
	required := map[string]int{spec.Capability(): spec.Version}
	var external *ExternalPackageRef
	if definition.Source.Normalized().Kind == contentdefs.SourceKindPackage {
		// External components need schema 3: the package block has no
		// schema 2 form, so legacy Players keep the compatibility
		// presentation.
		if schemaVersion == componentPresentationSchemaLegacy {
			return nil, nil
		}
		ref, ok, err := s.externalPackageRef(definition)
		if err != nil {
			return nil, err
		}
		if !ok {
			// No verified bundle: the Widget stays on its
			// compatibility presentation rather than naming code
			// the Player cannot fetch.
			return nil, nil
		}
		required = map[string]int{contentdefs.ExternalRuntimeCapability: contentdefs.ExternalRuntimeVersion}
		external = ref
	}
	configuration := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &configuration); err != nil {
			return nil, err
		}
	}
	// Schema 2 cannot carry the component empty policy. Preserve an opted-in
	// Widget's compatibility behavior for those Players. Schema 3 applies the
	// policy from the declared component spec at fullscreen mount time.
	if definition.HasFallback() {
		if autoSkip, _ := configuration["autoSkipWhenEmpty"].(bool); autoSkip &&
			(schemaVersion < contentdefs.ComponentPresentationSchemaVersion || spec.Empty != "skip-eligible") {
			return nil, nil
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
		SchemaVersion:        schemaVersion,
		Kind:                 "component",
		RequiredCapabilities: required,
		Component: &ComponentPresentation{
			Type: spec.Type, Version: spec.Version, Config: config,
			DataSources: dataSources, Media: componentMedia(definition, configuration),
			Empty:   componentEmptyPolicy(spec, schemaVersion),
			Package: external,
		},
	}, nil
}

// externalPackageRef builds the verified download claim for a
// package-contributed Widget. It answers ok=false when no bundle is
// snapshotted (unwired resolver or a skipped rebuild); a definition
// outside its own package namespace is corruption and errors.
func (s *Service) externalPackageRef(definition contentdefs.WidgetDefinition) (*ExternalPackageRef, bool, error) {
	source := definition.Source.Normalized()
	nestedID, ok := strings.CutPrefix(definition.ID, source.PackageID+".")
	if !ok || nestedID == "" {
		return nil, false, fmt.Errorf("Widget %q escapes package %q", definition.ID, source.PackageID)
	}
	if s.packagePayloads == nil {
		return nil, false, nil
	}
	payload, ok := s.packagePayloads.WidgetPayload(source.PackageID, nestedID)
	if !ok {
		return nil, false, nil
	}
	return &ExternalPackageRef{
		PackageID:    source.PackageID,
		Digest:       payload.PackageDigest,
		SHA256:       payload.SHA256Hex,
		FileSize:     payload.Size,
		DownloadPath: "/api/v1/player/packages/" + source.PackageID + "/widgets/" + nestedID,
	}, true, nil
}

func componentEmptyPolicy(spec contentdefs.ComponentSpec, schemaVersion int) string {
	if schemaVersion < contentdefs.ComponentPresentationSchemaVersion {
		return ""
	}
	return spec.Empty
}

// mediaSelection pairs a media_asset field with the configuration object holding its
// selection: the root configuration for top-level fields, a repeating-group item below.
type mediaSelection struct {
	field  contentdefs.FieldDefinition
	holder map[string]any
}

// collectMediaSelections walks media_asset fields recursively through repeating
// groups, so nested media projects and grants exactly like top-level media.
func collectMediaSelections(fields []contentdefs.FieldDefinition, values map[string]any) []mediaSelection {
	selections := []mediaSelection{}
	for _, field := range fields {
		switch field.Control {
		case "media_asset":
			selections = append(selections, mediaSelection{field: field, holder: values})
		case "repeating_group":
			if len(field.ItemFields) == 0 {
				continue
			}
			items, _ := values[field.Key].([]any)
			for _, item := range items {
				nested, ok := item.(map[string]any)
				if !ok {
					continue
				}
				selections = append(selections, collectMediaSelections(field.ItemFields, nested)...)
			}
		}
	}
	return selections
}

// componentMedia grants the media variants a component may display: each
// media_asset field whose asset manifest projection resolved to a variant.
// Projection writes the variant beside the asset under the derived key
// (imageAssetId gives imageVariantId), and adds that variant to the
// manifest's assets, so the Player verifies and caches it before
// activation. An asset without a projected variant grants nothing.
func componentMedia(definition contentdefs.WidgetDefinition, configuration map[string]any) []ComponentMediaRef {
	media := []ComponentMediaRef{}
	for _, selection := range collectMediaSelections(definition.ConfigurationSchema.Fields, configuration) {
		variantKey, ok := contentdefs.DerivedVariantKey(selection.field.Key)
		if !ok {
			continue
		}
		assetID, _ := selection.holder[selection.field.Key].(string)
		variantID, _ := selection.holder[variantKey].(string)
		asset, assetErr := uuid.Parse(assetID)
		variant, variantErr := uuid.Parse(variantID)
		if assetErr != nil || variantErr != nil || asset == uuid.Nil || variant == uuid.Nil {
			continue
		}
		media = append(media, ComponentMediaRef{AssetID: asset.String(), VariantID: variant.String()})
	}
	return media
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

// compatibilityConfiguration prepares a migrated Widget's saved
// configuration for its compatibility presentation. A Widgets V2 component
// reads a blank "timezone" as the organization timezone from its context,
// but some Players that predate Widgets V2 read a blank zone as UTC. The
// compatibility presentation therefore receives the organization timezone
// explicitly. The saved Widget does not change.
func (s *Service) compatibilityConfiguration(provider string, raw json.RawMessage, timezone string) json.RawMessage {
	definition, ok := s.definitions.Widget(provider)
	if !ok || definition.Component == nil || !definition.HasFallback() {
		return raw
	}
	var configuration map[string]any
	if json.Unmarshal(raw, &configuration) != nil {
		return raw
	}
	if value, present := configuration["timezone"]; !present || value != "" {
		return raw
	}
	configuration["timezone"] = timezone
	encoded, err := json.Marshal(configuration)
	if err != nil {
		return raw
	}
	return encoded
}
