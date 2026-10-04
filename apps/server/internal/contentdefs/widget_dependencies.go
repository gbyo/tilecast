package contentdefs

import (
	"encoding/json"

	"github.com/google/uuid"
)

// WidgetDataSourceIDs resolves playback dependencies from the release schema.
// Repeating groups follow DataSourceFieldValues; App recipes also carry their
// compiled managed source. Legacy providers keep their dataSourceId contract.
func (c *Catalog) WidgetDataSourceIDs(provider string, raw json.RawMessage) []uuid.UUID {
	var values map[string]any
	if json.Unmarshal(raw, &values) != nil {
		return nil
	}
	ids := []uuid.UUID{}
	seen := map[uuid.UUID]bool{}
	appendID := func(value string) {
		id, err := uuid.Parse(value)
		if err == nil && id != uuid.Nil && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if definition, ok := c.Widget(provider); ok && !definition.LegacyEditor {
		if definition.Recipe != nil {
			value, _ := values["managedDataSourceId"].(string)
			appendID(value)
		}
		for _, value := range DataSourceFieldValues(definition.ConfigurationSchema.Fields, values) {
			appendID(value)
		}
		return ids
	}
	switch provider {
	case "ticker", "menu", "list", "table", "agenda", "metric", "cards", "weather", "spotlight", "stat_grid", "chart", "progress", "timeline":
		value, _ := values["dataSourceId"].(string)
		appendID(value)
	}
	return ids
}
