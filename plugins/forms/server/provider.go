package server

import (
	"encoding/json"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

var _ plugin.DataSourceProvider = (*Service)(nil)

// ProviderID is the stored provider identifier. It never changes: existing
// rows and Widget bindings already use "form".
func (s *Service) ProviderID() string { return providerName }

// Traits declares the generic compatibility of approved Form output: record
// rows with temporal and numeric values and date selection. Core keeps
// matching Widgets and Layout bindings against these.
func (s *Service) Traits() plugin.DataSourceTraits {
	return plugin.DataSourceTraits{
		RecordBased: true, Temporal: true, Numeric: true,
		SupportsDateSelection: true, ProducesFields: true,
	}
}

// NormalizeConfiguration validates a stored configuration shape strictly.
func (s *Service) NormalizeConfiguration(raw json.RawMessage) (json.RawMessage, error) {
	config, err := normalizeFormConfig(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(config)
}

// FieldsFromConfig derives the selectable output fields from a stored
// configuration, so Widget field discovery needs no extra query.
func (s *Service) FieldsFromConfig(raw json.RawMessage) []plugin.DataSourceField {
	var config FormSourceConfig
	_ = json.Unmarshal(raw, &config)
	fields := make([]plugin.DataSourceField, 0, len(config.Fields))
	for _, field := range config.Fields {
		fields = append(fields, plugin.DataSourceField{Key: field.Key, Label: field.Label, Type: field.Type})
	}
	return fields
}

// Catalog is the gallery label, group, and description.
func (s *Service) Catalog() (label, group, description string) {
	return "Form", "Interactive", "Collect submissions, approve them, and publish records to Widgets."
}

// CanonicalEditor is the Studio route managing one instance. The generic
// Data Source UI redirects there instead of opening its own editor, so
// legacy /data-sources/... links keep working.
func (s *Service) CanonicalEditor() string { return "/plugins/forms/:id" }

// CanonicalCreator is the Studio route creating an instance.
func (s *Service) CanonicalCreator() string { return "/plugins/forms/new" }

// ManagedExternally reports Forms is authored through its own plugin API,
// so generic create, update, and duplicate refuse.
func (s *Service) ManagedExternally() bool { return true }

// HiddenFromGallery keeps Forms out of the generic Data Source creation
// gallery: operators create it through Plugins → Forms. Approved output
// still behaves like an ordinary typed Data Source to Widgets and Layout
// bindings.
func (s *Service) HiddenFromGallery() bool { return true }

// ExternalMessage is the refusal a generic path answers with. The wording
// matches the historical core messages exactly.
func (s *Service) ExternalMessage(action string) string {
	switch action {
	case "create":
		return "form Data Sources are created through the forms API"
	case "update":
		return "form Data Sources are edited through the forms API"
	case "duplicate":
		return "form Data Sources cannot be duplicated"
	default:
		return "form Data Sources are managed through the forms API"
	}
}

// CanonicalEditorRoute resolves the Studio editor route for one instance.
func CanonicalEditorRoute(id uuid.UUID) string { return "/plugins/forms/" + id.String() }
