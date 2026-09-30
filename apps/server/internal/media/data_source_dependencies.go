package media

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

type dataSourceUsageQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// dataSourceWidgetUsageWith is the canonical Widget -> Data Source dependency lookup.
// Release-defined Widgets are inspected according to their schema, including nested
// repeating_group controls. Legacy Widgets keep an exact-value recursive fallback because
// their provider-specific configuration predates declarative field metadata.
func (s *Service) dataSourceWidgetUsageWith(ctx context.Context, q dataSourceUsageQuerier, id uuid.UUID, excludeWidget *uuid.UUID) ([]DataSourceWidgetUsage, error) {
	rows, err := q.Query(ctx, `SELECT a.id,a.name,w.provider,w.configuration,w.managed_data_source_id FROM widgets w JOIN assets a ON a.id=w.asset_id AND a.deleted_at IS NULL ORDER BY lower(a.name),a.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	usage := []DataSourceWidgetUsage{}
	for rows.Next() {
		var item DataSourceWidgetUsage
		var configuration json.RawMessage
		var managedDataSourceID *uuid.UUID
		if err = rows.Scan(&item.ID, &item.Name, &item.Provider, &configuration, &managedDataSourceID); err != nil {
			return nil, err
		}
		if excludeWidget != nil && item.ID == *excludeWidget {
			continue
		}
		if s.widgetConfigurationReferencesDataSource(item.Provider, configuration, managedDataSourceID, id) {
			usage = append(usage, item)
		}
	}
	return usage, rows.Err()
}

func (s *Service) widgetConfigurationReferencesDataSource(provider string, raw json.RawMessage, managedDataSourceID *uuid.UUID, target uuid.UUID) bool {
	if managedDataSourceID != nil && *managedDataSourceID == target {
		return true
	}
	var configuration map[string]any
	if json.Unmarshal(raw, &configuration) != nil {
		return false
	}
	if definition, ok := s.definitions.Widget(provider); ok && !definition.LegacyEditor {
		return fieldsReferenceDataSource(definition.ConfigurationSchema.Fields, configuration, target.String())
	}
	return jsonValueContainsExactString(configuration, target.String())
}

func fieldsReferenceDataSource(fields []contentdefs.FieldDefinition, configuration map[string]any, target string) bool {
	for _, selected := range contentdefs.DataSourceFieldValues(fields, configuration) {
		if selected == target {
			return true
		}
	}
	return false
}

func jsonValueContainsExactString(value any, target string) bool {
	switch typed := value.(type) {
	case string:
		return typed == target
	case []any:
		for _, item := range typed {
			if jsonValueContainsExactString(item, target) {
				return true
			}
		}
	case map[string]any:
		for _, item := range typed {
			if jsonValueContainsExactString(item, target) {
				return true
			}
		}
	}
	return false
}

func (s *Service) dataSourceHasExternalConsumersInTx(ctx context.Context, tx pgx.Tx, id, ownerWidget uuid.UUID) (bool, error) {
	widgets, err := s.dataSourceWidgetUsageWith(ctx, tx, id, &ownerWidget)
	if err != nil {
		return false, err
	}
	if len(widgets) > 0 {
		return true, nil
	}
	var bound bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM layout_draft_dependencies WHERE dependency_id=$1 AND dependency_type='data_source') OR EXISTS(SELECT 1 FROM layout_revision_dependencies WHERE dependency_id=$1 AND dependency_type='data_source')`, id).Scan(&bound)
	return bound, err
}
