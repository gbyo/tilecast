package managedpresentations

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Service owns the core content rows behind a system-managed Widget playlist.
// The caller supplies content, but never writes these core tables itself.
type Service struct {
	db          *pgxpool.Pool
	definitions contentdefs.Catalogs
}

func NewService(db *pgxpool.Pool) *Service {
	return &Service{db: db, definitions: contentdefs.MustLoad()}
}

func (s *Service) SetContentDefinitions(catalog contentdefs.Catalogs) {
	s.definitions = catalog
}

func (s *Service) widgetConfigVersion(provider string) int {
	if s.definitions == nil {
		return 1
	}
	definition, ok := s.definitions.Widget(provider)
	if !ok {
		return 1
	}
	return definition.PersistedConfigVersion()
}

func (s *Service) EnsureInTx(ctx context.Context, tx pgx.Tx, existing plugin.ManagedPresentation, request plugin.ManagedPresentationRequest) (plugin.ManagedPresentation, error) {
	if !json.Valid([]byte(request.DataSourceConfiguration)) || !json.Valid([]byte(request.CachedPayload)) || request.WidgetConfiguration == nil || request.Name == "" || request.DataSourceProvider == "" || request.WidgetProvider == "" {
		return plugin.ManagedPresentation{}, errors.New("invalid managed presentation")
	}
	if existing.DataSourceID != uuid.Nil && existing.WidgetID != uuid.Nil && existing.PlaylistID != uuid.Nil {
		var source, widget, playlist bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM data_sources WHERE id=$1 AND system_managed AND deleted_at IS NULL), EXISTS(SELECT 1 FROM assets WHERE id=$2 AND system_managed AND deleted_at IS NULL), EXISTS(SELECT 1 FROM playlists WHERE id=$3 AND system_managed AND deleted_at IS NULL)`, existing.DataSourceID, existing.WidgetID, existing.PlaylistID).Scan(&source, &widget, &playlist)
		if err != nil {
			return plugin.ManagedPresentation{}, err
		}
		if source && widget && playlist {
			return existing, nil
		}
	}
	org := uuid.Nil
	if err := tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&org); err != nil {
		return plugin.ManagedPresentation{}, err
	}
	result := plugin.ManagedPresentation{DataSourceID: uuid.New(), WidgetID: uuid.New(), PlaylistID: uuid.New()}
	widgetConfiguration := request.WidgetConfiguration(result.DataSourceID)
	if !json.Valid([]byte(widgetConfiguration)) {
		return plugin.ManagedPresentation{}, errors.New("invalid widget configuration")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration,created_by,system_managed) VALUES($1,$2,$3,$4,$5,1,$6::jsonb,$7,TRUE)`, result.DataSourceID, org, request.Name, request.Description, request.DataSourceProvider, request.DataSourceConfiguration, request.CreatedBy); err != nil {
		return plugin.ManagedPresentation{}, err
	}
	expires := request.CacheExpiresAt
	if expires.IsZero() {
		expires = time.Now().AddDate(100, 0, 0)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at,last_attempt_at,last_success_at,http_result_category,parse_status,available_item_count,cache_updated_at,cache_expires_at,cached_payload) VALUES($1,now()+interval '100 years',now(),now(),$2,'success',1,now(),$3,$4::jsonb)`, result.DataSourceID, request.CacheCategory, expires, request.CachedPayload); err != nil {
		return plugin.ManagedPresentation{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO assets(id,organization_id,name,description,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by,system_managed) VALUES($1,$2,$3,$4,'widget','','application/vnd.tilecast.widget+json',''::bytea,0,'ready',$5,TRUE)`, result.WidgetID, org, request.Name, request.Description, request.CreatedBy); err != nil {
		return plugin.ManagedPresentation{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO widgets(asset_id,provider,config_version,configuration) VALUES($1,$2,$3,$4::jsonb)`, result.WidgetID, request.WidgetProvider, s.widgetConfigVersion(request.WidgetProvider), widgetConfiguration); err != nil {
		return plugin.ManagedPresentation{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,description,created_by,system_managed) VALUES($1,$2,$3,$4,$5,TRUE)`, result.PlaylistID, org, request.Name, request.Description, request.CreatedBy); err != nil {
		return plugin.ManagedPresentation{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO playlist_items(id,playlist_id,asset_id,position,fit_mode,transition,audio_enabled,volume,delivery_policy) VALUES($1,$2,$3,0,'contain','none',FALSE,0,'stream')`, uuid.New(), result.PlaylistID, result.WidgetID); err != nil {
		return plugin.ManagedPresentation{}, err
	}
	return result, nil
}

func (s *Service) UpdateDataInTx(ctx context.Context, tx pgx.Tx, dataSourceID uuid.UUID, configuration, cachedPayload, cacheCategory string, cacheExpiresAt time.Time) (bool, error) {
	if !json.Valid([]byte(configuration)) || !json.Valid([]byte(cachedPayload)) {
		return false, errors.New("invalid managed data")
	}
	tag, err := tx.Exec(ctx, `UPDATE data_sources SET configuration=$2::jsonb,updated_at=now() WHERE id=$1 AND system_managed=TRUE AND configuration IS DISTINCT FROM $2::jsonb`, dataSourceID, configuration)
	if err != nil || tag.RowsAffected() == 0 {
		return false, err
	}
	_, err = tx.Exec(ctx, `UPDATE data_source_refresh_states SET last_attempt_at=now(),last_success_at=now(),http_result_category=$2,parse_status='success',available_item_count=1,using_cached_data=FALSE,cache_updated_at=now(),cache_expires_at=$3,cached_payload=$4::jsonb,error_code=NULL,updated_at=now() WHERE data_source_id=$1`, dataSourceID, cacheCategory, cacheExpiresAt, cachedPayload)
	return true, err
}

func (s *Service) PlaylistName(ctx context.Context, id uuid.UUID) (string, error) {
	var name string
	err := s.db.QueryRow(ctx, `SELECT name FROM playlists WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&name)
	return name, err
}
