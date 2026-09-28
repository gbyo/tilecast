package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

type preparedAppRecipe struct {
	author     map[string]any
	widget     map[string]any
	source     any
	sourceJSON []byte
	authorJSON []byte
	widgetJSON []byte
}

func (s *Service) prepareAppRecipe(ctx context.Context, definition contentdefs.WidgetDefinition, raw json.RawMessage, sourceID uuid.UUID) (preparedAppRecipe, error) {
	if definition.Recipe == nil {
		return preparedAppRecipe{}, errors.New("Widget is not an App recipe")
	}
	authorValue, err := (definitionConfigNormalizer{service: s, schema: definition.ConfigurationSchema}).Normalize(ctx, raw)
	if err != nil {
		return preparedAppRecipe{}, err
	}
	author := authorValue.(map[string]any)
	var template any
	if err = json.Unmarshal(definition.Recipe.DataSource.ConfigurationTemplate, &template); err != nil {
		return preparedAppRecipe{}, err
	}
	resolved, err := resolveAppRecipeTemplate(template, author)
	if err != nil {
		return preparedAppRecipe{}, err
	}
	resolvedJSON, err := json.Marshal(resolved)
	if err != nil {
		return preparedAppRecipe{}, err
	}
	sourceNormalizer, err := s.dataSourceProvider(definition.Recipe.DataSource.Provider)
	if err != nil {
		return preparedAppRecipe{}, err
	}
	source, err := sourceNormalizer.Normalize(ctx, resolvedJSON)
	if err != nil {
		return preparedAppRecipe{}, fmt.Errorf("managed Data Source: %w", err)
	}
	widget := make(map[string]any, len(author)+2)
	for key, value := range author {
		widget[key] = value
	}
	widget["managedDataSourceId"] = sourceID.String()
	widget["sourceId"] = sourceID.String()
	widget["appProviderName"] = definition.Name
	authorJSON, _ := json.Marshal(author)
	widgetJSON, _ := json.Marshal(widget)
	sourceJSON, _ := json.Marshal(source)
	return preparedAppRecipe{author: author, widget: widget, source: source, sourceJSON: sourceJSON, authorJSON: authorJSON, widgetJSON: widgetJSON}, nil
}

func resolveAppRecipeTemplate(value any, configuration map[string]any) (any, error) {
	switch typed := value.(type) {
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			resolved, err := resolveAppRecipeTemplate(item, configuration)
			if err != nil {
				return nil, err
			}
			result[index] = resolved
		}
		return result, nil
	case map[string]any:
		if key, ok := typed["$config"].(string); ok {
			resolved, exists := configuration[key]
			if !exists {
				return nil, fmt.Errorf("recipe references missing configuration %q", key)
			}
			return resolved, nil
		}
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			resolved, err := resolveAppRecipeTemplate(item, configuration)
			if err != nil {
				return nil, err
			}
			result[key] = resolved
		}
		return result, nil
	default:
		return value, nil
	}
}

func (s *Service) createAppRecipeWidget(ctx context.Context, user uuid.UUID, input WidgetInput, definition contentdefs.WidgetDefinition) (Asset, error) {
	sourceID := uuid.New()
	prepared, err := s.prepareAppRecipe(ctx, definition, input.Configuration, sourceID)
	if err != nil {
		return Asset{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Asset{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var organizationID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&organizationID); err != nil {
		return Asset{}, err
	}
	if err = s.lockWidgetSource(ctx, tx, input.Provider); err != nil {
		return Asset{}, err
	}
	sourceName := strings.TrimSpace(input.Name + " · " + definition.Recipe.DataSource.Name)
	if err = s.insertManagedAppSource(ctx, tx, sourceID, organizationID, user, sourceName, definition.Recipe.DataSource.Description, definition.Recipe.DataSource.Provider, prepared); err != nil {
		return Asset{}, err
	}
	widgetID := uuid.New()
	if _, err = tx.Exec(ctx, `INSERT INTO assets(id,organization_id,name,description,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by) VALUES($1,$2,$3,$4,'widget','','application/vnd.tilecast.widget+json',''::bytea,0,'ready',$5)`, widgetID, organizationID, input.Name, input.Description, user); err != nil {
		return Asset{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO widgets(asset_id,provider,config_version,configuration,app_configuration,managed_data_source_id) VALUES($1,$2,1,$3::jsonb,$4::jsonb,$5)`, widgetID, input.Provider, string(prepared.widgetJSON), string(prepared.authorJSON), sourceID); err != nil {
		return Asset{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,'widget_app.created','widget',$3,jsonb_build_object('provider',$4::text,'managedDataSourceId',$5::text))`, uuid.New(), user, widgetID.String(), input.Provider, sourceID.String()); err != nil {
		return Asset{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Asset{}, err
	}
	return s.GetAsset(ctx, widgetID)
}

func (s *Service) insertManagedAppSource(ctx context.Context, tx pgx.Tx, id, organizationID, user uuid.UUID, name, description, provider string, prepared preparedAppRecipe) error {
	if _, err := tx.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration,created_by,system_managed) VALUES($1,$2,$3,$4,$5,1,$6::jsonb,$7,TRUE)`, id, organizationID, name, description, provider, string(prepared.sourceJSON), user); err != nil {
		return err
	}
	if seed, ok, err := s.manualRefreshPayload(provider, prepared.source); ok {
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at,last_attempt_at,last_success_at,http_result_category,parse_status,available_item_count,cache_updated_at,cache_expires_at,cached_payload) VALUES($1,COALESCE($2,now()+interval '100 years'),now(),now(),'manual','success',$3,now(),now()+interval '100 years',$4::jsonb)`, id, seed.NextRefresh, seed.ItemCount, string(seed.Payload))
		return err
	} else if err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at) VALUES($1,now())`, id)
	return err
}

func (s *Service) updateAppRecipeWidget(ctx context.Context, id, user uuid.UUID, input WidgetInput, definition contentdefs.WidgetDefinition, existing Widget) (Asset, error) {
	if existing.ManagedDataSourceID == nil {
		return Asset{}, errors.New("App is missing its managed Data Source")
	}
	prepared, err := s.prepareAppRecipe(ctx, definition, input.Configuration, *existing.ManagedDataSourceID)
	if err != nil {
		return Asset{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Asset{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if tag, updateErr := tx.Exec(ctx, `UPDATE assets SET name=$2,description=$3,updated_at=now() WHERE id=$1 AND type='widget' AND deleted_at IS NULL`, id, input.Name, input.Description); updateErr != nil || tag.RowsAffected() == 0 {
		if updateErr != nil {
			return Asset{}, updateErr
		}
		return Asset{}, ErrNotFound
	}
	if _, err = tx.Exec(ctx, `UPDATE widgets SET configuration=$2::jsonb,app_configuration=$3::jsonb,updated_at=now(),preview_image=NULL,preview_content_type=NULL,preview_width=NULL,preview_height=NULL,preview_updated_at=NULL WHERE asset_id=$1`, id, string(prepared.widgetJSON), string(prepared.authorJSON)); err != nil {
		return Asset{}, err
	}
	if tag, updateErr := tx.Exec(ctx, `UPDATE data_sources SET name=$2,description=$3,configuration=$4::jsonb,updated_at=now() WHERE id=$1 AND system_managed=TRUE AND deleted_at IS NULL`, *existing.ManagedDataSourceID, input.Name+" · "+definition.Recipe.DataSource.Name, definition.Recipe.DataSource.Description, string(prepared.sourceJSON)); updateErr != nil || tag.RowsAffected() == 0 {
		if updateErr != nil {
			return Asset{}, updateErr
		}
		return Asset{}, errors.New("managed Data Source is unavailable")
	}
	if _, err = tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at) VALUES($1,now()) ON CONFLICT(data_source_id) DO UPDATE SET next_refresh_at=now(),error_code=NULL,locked_at=NULL,locked_by=NULL,updated_at=now()`, *existing.ManagedDataSourceID); err != nil {
		return Asset{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'widget_app.updated','widget',$3)`, uuid.New(), user, id.String()); err != nil {
		return Asset{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Asset{}, err
	}
	if s.invalidator != nil {
		_ = s.invalidator.DataSourceChanged(ctx, *existing.ManagedDataSourceID, "widget_app.updated")
	}
	return s.GetAsset(ctx, id)
}
