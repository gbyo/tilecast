package contentdefs

import "fmt"

// AuthoringProblem reports why Studio cannot author a Widget definition, or
// "" when it can (docs/widget-authoring.md). Studio has one Widget editor
// and no per-provider fallback, so every authorable definition must
// describe itself declaratively:
//
//   - a native Widget renders through its component; its configuration
//     schema (which may be empty) is what the inspector shows;
//   - a web integration declares the configuration schema the inspector
//     shows, including the field that holds its address.
//
// A disabled definition is not authorable and is exempt: Studio shows its
// availability reason instead of an editor.
func AuthoringProblem(definition WidgetDefinition) string {
	if !definition.Availability.IsEnabled() {
		return ""
	}
	switch definition.Runtime {
	case "native":
		if definition.Component == nil {
			return "is a native Widget without a component"
		}
	case "web":
		urlField := "url"
		if definition.WebIntegration != nil {
			urlField = definition.WebIntegration.URLField
		} else if !definition.LegacyEditor {
			return "is a web integration without a webIntegration contract"
		}
		if !hasField(definition.ConfigurationSchema.Fields, urlField) {
			return fmt.Sprintf("is a web integration without its %q address field", urlField)
		}
	default:
		return fmt.Sprintf("has unsupported runtime %q", definition.Runtime)
	}
	return ""
}

func hasField(fields []FieldDefinition, key string) bool {
	for _, field := range fields {
		if field.Key == key {
			return true
		}
	}
	return false
}
