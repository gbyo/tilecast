package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// DataSourceProviders collects the Data Source provider contributions of
// every hosted plugin in deterministic provider-ID order. Core Media
// receives the complete set without knowing which plugin contributed each
// one. Duplicate provider IDs, collisions with static core providers, and
// malformed provider IDs fail loudly: two plugins must never own one stored
// provider, and a half-wired provider must never run.
func (s *Service) DataSourceProviders() ([]plugin.DataSourceProvider, error) {
	providers := []plugin.DataSourceProvider{}
	seen := map[string]string{}
	for _, hosted := range s.hosted {
		provider, ok := hosted.plugin.(plugin.DataSourceProvider)
		if !ok {
			continue
		}
		id := provider.ProviderID()
		if !plugin.ProviderIDPattern.MatchString(id) {
			return nil, fmt.Errorf("plugin %s: malformed data source provider id %q", hosted.manifest.ID, id)
		}
		if other, dup := seen[id]; dup {
			return nil, fmt.Errorf("plugins %s and %s contribute duplicate data source provider %q", other, hosted.manifest.ID, id)
		}
		if media.IsStaticDataSourceProvider(id) {
			return nil, fmt.Errorf("plugin %s: data source provider %q collides with a core provider", hosted.manifest.ID, id)
		}
		seen[id] = hosted.manifest.ID
		providers = append(providers, provider)
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i].ProviderID() < providers[j].ProviderID() })
	return providers, nil
}

// farFutureRefresh parks a Data Source out of the generic refresh worker;
// the owning plugin's worker reschedules it to the next real boundary.
const farFutureRefresh = "now()+interval '100 years'"

// DataSourceInvalidator runs the normal Data Source manifest path for a
// plugin-owned row. It is implemented by the playlist service; main wires
// it, and the pluginharness wires it for plugin integration tests.
type DataSourceInvalidator interface {
	DataSourceChangedInTx(ctx context.Context, tx pgx.Tx, dataSourceID uuid.UUID, reason string) ([]manifestchanges.Change, error)
	NotifyManifestChanges(changes []manifestchanges.Change)
}

// AttachmentBackend stores and serves private plugin-managed uploads. It is
// implemented by the media service; main wires it. The stored origin stays
// the historical form-attachment classification so existing rows keep
// working; per-plugin ownership is the enforced signal (see migration 00106
// and the Plugin API ADR for the compatibility debt).
type AttachmentBackend interface {
	IngestPrivateAsset(ctx context.Context, pluginID string, userID uuid.UUID, filename, declaredMIME string, data []byte) (media.Asset, error)
	SoftDeletePrivateAsset(ctx context.Context, pluginID string, assetID uuid.UUID) error
	PrivateAssetDelivery(ctx context.Context, pluginID string, assetID uuid.UUID) (media.Delivery, error)
}

// WithDataSourceInvalidator wires the normal Data Source revision path for
// Host.DataSources. Without it, projection writes store but never notify.
func WithDataSourceInvalidator(invalidator DataSourceInvalidator) Option {
	return func(s *Service) { s.dsInvalidator = invalidator }
}

// WithAttachments wires private-asset storage for Host.PluginAssets.
func WithAttachments(backend AttachmentBackend) Option {
	return func(s *Service) { s.attachments = backend }
}

// dataSourceService implements plugin.DataSources: the core mechanics of a
// provider-owned data_sources row. The plugin owns its domain tables and the
// projection content; everything here is the shared row, refresh-state, and
// usage machinery every provider-owned source needs. The service is bound to
// one contributed provider ID at Host construction: every provider-scoped
// method reads and writes that provider's rows, and rows of any other
// provider read as absent. An empty provider means the plugin contributes
// none, and every provider-scoped call is refused.
type dataSourceService struct {
	db          *pgxpool.Pool
	invalidator DataSourceInvalidator
	pluginID    string
	provider    string
}

// errNoDataSourceProvider refuses provider-scoped calls from a plugin that
// contributes no Data Source provider.
func (s dataSourceService) errNoDataSourceProvider() error {
	return fmt.Errorf("plugin %s does not contribute a data source provider", s.pluginID)
}

func scanDataSourceRecord(row pgx.Row) (plugin.DataSourceRecord, error) {
	var record plugin.DataSourceRecord
	var createdBy *uuid.UUID
	var raw []byte
	err := row.Scan(&record.ID, &record.Provider, &record.Name, &record.Description, &raw,
		&createdBy, &record.CreatedAt, &record.UpdatedAt)
	if err != nil {
		return plugin.DataSourceRecord{}, err
	}
	record.Configuration = json.RawMessage(raw)
	if createdBy != nil {
		record.CreatedBy = *createdBy
	}
	return record, nil
}

const dataSourceRecordSelect = `SELECT id,provider,name,description,configuration,created_by,created_at,updated_at
	FROM data_sources WHERE id=$1 AND provider=$2 AND deleted_at IS NULL`

func (s dataSourceService) CreateInTx(ctx context.Context, tx pgx.Tx, input plugin.DataSourceCreate) (plugin.DataSourceRecord, error) {
	if s.provider == "" {
		return plugin.DataSourceRecord{}, s.errNoDataSourceProvider()
	}
	var organizationID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&organizationID); err != nil {
		return plugin.DataSourceRecord{}, err
	}
	id := uuid.New()
	configuration := input.Configuration
	if len(configuration) == 0 {
		configuration = json.RawMessage(`{}`)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration,created_by)
		VALUES($1,$2,$3,$4,$5,1,$6::jsonb,$7)`,
		id, organizationID, input.Name, input.Description, s.provider, string(configuration), input.CreatedBy); err != nil {
		return plugin.DataSourceRecord{}, err
	}
	if seed := input.SeedRefresh; seed != nil {
		encoded, err := json.Marshal(seed.Payload)
		if err != nil {
			return plugin.DataSourceRecord{}, err
		}
		nextRefresh := farFutureRefresh
		args := []any{id, string(encoded), seed.ItemCount}
		if seed.NextRefresh != nil {
			nextRefresh = "$4"
			args = append(args, *seed.NextRefresh)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at,last_attempt_at,last_success_at,http_result_category,parse_status,available_item_count,using_cached_data,cache_updated_at,cache_expires_at,cached_payload)
			VALUES($1,`+nextRefresh+`,now(),now(),'manual','success',$3,FALSE,now(),now()+interval '100 years',$2::jsonb)`, args...); err != nil {
			return plugin.DataSourceRecord{}, err
		}
	} else if _, err := tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id) VALUES($1)`, id); err != nil {
		return plugin.DataSourceRecord{}, err
	}
	return scanDataSourceRecord(tx.QueryRow(ctx, dataSourceRecordSelect, id, s.provider))
}

func (s dataSourceService) Get(ctx context.Context, id uuid.UUID) (plugin.DataSourceRecord, error) {
	if s.provider == "" {
		return plugin.DataSourceRecord{}, s.errNoDataSourceProvider()
	}
	record, err := scanDataSourceRecord(s.db.QueryRow(ctx, dataSourceRecordSelect, id, s.provider))
	if errors.Is(err, pgx.ErrNoRows) {
		return plugin.DataSourceRecord{}, plugin.ErrNotFound
	}
	return record, err
}

func (s dataSourceService) ListLive(ctx context.Context) ([]plugin.DataSourceRecord, error) {
	if s.provider == "" {
		return nil, s.errNoDataSourceProvider()
	}
	rows, err := s.db.Query(ctx, `SELECT id,provider,name,description,configuration,created_by,created_at,updated_at
		FROM data_sources WHERE provider=$1 AND deleted_at IS NULL ORDER BY name,id`, s.provider)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []plugin.DataSourceRecord{}
	for rows.Next() {
		record, err := scanDataSourceRecord(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s dataSourceService) UpdateMetadataInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, name string, description *string) error {
	if s.provider == "" {
		return s.errNoDataSourceProvider()
	}
	tag, err := tx.Exec(ctx, `UPDATE data_sources SET name=$3,description=COALESCE($4,description),updated_at=now()
		WHERE id=$1 AND provider=$2 AND deleted_at IS NULL`, id, s.provider, name, description)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return plugin.ErrNotFound
	}
	return nil
}

func (s dataSourceService) Configuration(ctx context.Context, id uuid.UUID) (json.RawMessage, error) {
	if s.provider == "" {
		return nil, s.errNoDataSourceProvider()
	}
	return configurationIn(ctx, s.db, id, s.provider)
}

func (s dataSourceService) ConfigurationInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (json.RawMessage, error) {
	if s.provider == "" {
		return nil, s.errNoDataSourceProvider()
	}
	return configurationIn(ctx, tx, id, s.provider)
}

type configQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func configurationIn(ctx context.Context, q configQuerier, id uuid.UUID, provider string) (json.RawMessage, error) {
	var raw []byte
	err := q.QueryRow(ctx, `SELECT configuration FROM data_sources WHERE id=$1 AND provider=$2 AND deleted_at IS NULL`, id, provider).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, plugin.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

func (s dataSourceService) SetConfigurationInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, configuration json.RawMessage) error {
	if s.provider == "" {
		return s.errNoDataSourceProvider()
	}
	tag, err := tx.Exec(ctx, `UPDATE data_sources SET configuration=$3::jsonb,updated_at=now()
		WHERE id=$1 AND provider=$2 AND deleted_at IS NULL`, id, s.provider, string(configuration))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return plugin.ErrNotFound
	}
	return nil
}

func (s dataSourceService) RefreshState(ctx context.Context, id uuid.UUID) (plugin.DataSourceRefresh, error) {
	var state plugin.DataSourceRefresh
	var raw []byte
	state.Payload = plugin.TypedDatasetPayload{Datasets: []plugin.TypedDataset{}}
	err := s.db.QueryRow(ctx, `SELECT cached_payload,last_success_at,next_refresh_at,using_cached_data,error_code
		FROM data_source_refresh_states WHERE data_source_id=$1`, id).
		Scan(&raw, &state.LastSuccess, &state.NextRefresh, &state.UsingCached, &state.ErrorCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return plugin.DataSourceRefresh{}, err
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &state.Payload)
	}
	return state, nil
}

func (s dataSourceService) WriteProjectionInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, write plugin.ProjectionWrite) error {
	encoded, err := json.Marshal(write.Payload)
	if err != nil {
		return err
	}
	nextRefresh := farFutureRefresh
	args := []any{id, string(encoded), write.DatasetCount}
	if write.NextRefresh != nil {
		nextRefresh = "$4"
		args = append(args, *write.NextRefresh)
	}
	tag, err := tx.Exec(ctx, `UPDATE data_source_refresh_states SET next_refresh_at=`+nextRefresh+`,
		last_attempt_at=now(),last_success_at=now(),http_result_category='manual',parse_status='success',
		available_item_count=$3,using_cached_data=FALSE,cache_updated_at=now(),cache_expires_at=now()+interval '100 years',
		cached_payload=$2::jsonb,error_code=NULL,locked_at=NULL,locked_by=NULL,updated_at=now()
		WHERE data_source_id=$1`, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Seed the refresh row if it is somehow missing so the source still projects.
		_, err = tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at,last_attempt_at,last_success_at,http_result_category,parse_status,available_item_count,using_cached_data,cache_updated_at,cache_expires_at,cached_payload)
			VALUES($1,now()+interval '100 years',now(),now(),'manual','success',$2,FALSE,now(),now()+interval '100 years',$3::jsonb)
			ON CONFLICT(data_source_id) DO NOTHING`, id, write.DatasetCount, string(encoded))
	}
	return err
}

func (s dataSourceService) InvalidateDataSourceInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) (plugin.AfterCommit, error) {
	if s.invalidator == nil {
		return func() {}, nil
	}
	changes, err := s.invalidator.DataSourceChangedInTx(ctx, tx, id, reason)
	if err != nil {
		return nil, err
	}
	return func() { s.invalidator.NotifyManifestChanges(changes) }, nil
}

func (s dataSourceService) ClaimDueInTx(ctx context.Context, tx pgx.Tx, limit int) ([]uuid.UUID, error) {
	if s.provider == "" {
		return nil, s.errNoDataSourceProvider()
	}
	if limit <= 0 {
		limit = 50
	}
	rows, err := tx.Query(ctx, `SELECT rs.data_source_id
		FROM data_source_refresh_states rs
		JOIN data_sources ds ON ds.id=rs.data_source_id AND ds.deleted_at IS NULL AND ds.provider=$1
		WHERE rs.next_refresh_at<=now()
		FOR UPDATE OF rs SKIP LOCKED
		LIMIT $2`, s.provider, limit)
	if err != nil {
		return nil, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	return ids, rows.Err()
}

func (s dataSourceService) Usage(ctx context.Context, id uuid.UUID, dataset string) (plugin.DataSourceUsage, error) {
	rows, err := s.db.Query(ctx, `SELECT a.name FROM widgets w
		JOIN assets a ON a.id=w.asset_id AND a.deleted_at IS NULL
		WHERE w.configuration->>'dataSourceId'=$1 AND ($2='' OR w.configuration->>'dataset'=$2)
		ORDER BY lower(a.name),a.id`, id.String(), dataset)
	if err != nil {
		return plugin.DataSourceUsage{}, err
	}
	defer rows.Close()
	usage := plugin.DataSourceUsage{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return plugin.DataSourceUsage{}, err
		}
		usage.Names = append(usage.Names, "widget "+name)
	}
	if err := rows.Err(); err != nil {
		return plugin.DataSourceUsage{}, err
	}
	usage.Widgets = len(usage.Names)
	return usage, nil
}

func (s dataSourceService) CountLive(ctx context.Context) (int, error) {
	if s.provider == "" {
		return 0, s.errNoDataSourceProvider()
	}
	var count int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM data_sources WHERE provider=$1 AND deleted_at IS NULL`, s.provider).Scan(&count)
	return count, err
}

func (s dataSourceService) CountLiveInTx(ctx context.Context, tx pgx.Tx) (int, error) {
	if s.provider == "" {
		return 0, s.errNoDataSourceProvider()
	}
	var count int
	err := tx.QueryRow(ctx, `SELECT count(*) FROM data_sources WHERE provider=$1 AND deleted_at IS NULL`, s.provider).Scan(&count)
	return count, err
}

// userService implements plugin.Users: read-only facts about core users.
// It never exposes credentials, password hashes, MFA state, or sessions.
type userService struct {
	db *pgxpool.Pool
}

func scanDirectoryUser(row pgx.Row) (plugin.DirectoryUser, error) {
	var user plugin.DirectoryUser
	err := row.Scan(&user.ID, &user.Name, &user.Username, &user.Role, &user.Active)
	return user, err
}

const directoryUserSelect = `SELECT id,name,username,role,active FROM users WHERE id=$1`

func (s userService) Get(ctx context.Context, id uuid.UUID) (plugin.DirectoryUser, error) {
	return getDirectoryUser(ctx, s.db, id)
}

func (s userService) GetInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (plugin.DirectoryUser, error) {
	return getDirectoryUser(ctx, tx, id)
}

type directoryQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func getDirectoryUser(ctx context.Context, q directoryQuerier, id uuid.UUID) (plugin.DirectoryUser, error) {
	user, err := scanDirectoryUser(q.QueryRow(ctx, directoryUserSelect, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return plugin.DirectoryUser{}, plugin.ErrNotFound
	}
	return user, err
}

// defaultDirectoryLimit bounds directory searches; SearchActive never returns
// an unbounded list.
const defaultDirectoryLimit = 20
const maxDirectoryLimit = 100

func (s userService) SearchActive(ctx context.Context, query string, limit int) ([]plugin.DirectoryUser, error) {
	if limit <= 0 {
		limit = defaultDirectoryLimit
	}
	if limit > maxDirectoryLimit {
		limit = maxDirectoryLimit
	}
	query = strings.TrimSpace(query)
	rows, err := s.db.Query(ctx, `SELECT id,name,username,role,active FROM users
		WHERE active AND ($1='' OR name ILIKE '%'||$1||'%' OR username ILIKE '%'||$1||'%')
		ORDER BY lower(name),id
		LIMIT $2`, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []plugin.DirectoryUser{}
	for rows.Next() {
		user, err := scanDirectoryUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s userService) ListByRole(ctx context.Context, role string) ([]plugin.DirectoryUser, error) {
	rows, err := s.db.Query(ctx, `SELECT id,name,username,role,active FROM users
		WHERE role=$1 AND active ORDER BY lower(name),id`, role)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []plugin.DirectoryUser{}
	for rows.Next() {
		user, err := scanDirectoryUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

// pluginAssetService implements plugin.PluginAssets over the media backend.
// The service is bound to the calling plugin's identity at Host
// construction: ingest stamps the owner, and claim, discard, and delivery
// verify it, so a plugin cannot operate on another plugin's private assets.
// The plugin still authorizes every call against its own records first; this
// service enforces the ownership boundary underneath.
type pluginAssetService struct {
	db       *pgxpool.Pool
	backend  AttachmentBackend
	pluginID string
}

func (s pluginAssetService) IngestPrivate(ctx context.Context, userID uuid.UUID, filename, mimeType string, data []byte) (plugin.PrivateAsset, error) {
	if s.backend == nil {
		return plugin.PrivateAsset{}, errors.New("plugin assets are not configured")
	}
	asset, err := s.backend.IngestPrivateAsset(ctx, s.pluginID, userID, filename, mimeType, data)
	if errors.Is(err, media.ErrUploadTooLarge) {
		return plugin.PrivateAsset{}, plugin.ErrTooLarge
	}
	if errors.Is(err, media.ErrUnsupportedType) || isPrivateInputError(err) {
		return plugin.PrivateAsset{}, fmt.Errorf("%w: %v", plugin.ErrInvalid, err)
	}
	if err != nil {
		return plugin.PrivateAsset{}, err
	}
	return plugin.PrivateAsset{ID: asset.ID}, nil
}

// isPrivateInputError matches caller-correctable ingest failures the backend
// reports as plain errors.
func isPrivateInputError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "must be images") || strings.Contains(message, "attachment is empty")
}

func (s pluginAssetService) DiscardPrivate(ctx context.Context, assetID uuid.UUID) error {
	if s.backend == nil {
		return errors.New("plugin assets are not configured")
	}
	err := s.backend.SoftDeletePrivateAsset(ctx, s.pluginID, assetID)
	if err != nil && strings.Contains(err.Error(), "is not a private asset of this plugin") {
		return fmt.Errorf("%w: %v", plugin.ErrInvalid, err)
	}
	return err
}

func (s pluginAssetService) ClaimPrivateInTx(ctx context.Context, tx pgx.Tx, assetID uuid.UUID) error {
	var origin string
	var owner *string
	err := tx.QueryRow(ctx, `SELECT origin,owning_plugin FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, assetID).Scan(&origin, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: attachment asset does not exist", plugin.ErrInvalid)
	}
	if err != nil {
		return err
	}
	if origin != "form_attachment" {
		return fmt.Errorf("%w: only dedicated private attachments may be attached", plugin.ErrInvalid)
	}
	if owner == nil || *owner != s.pluginID {
		return fmt.Errorf("%w: attachment asset belongs to another plugin", plugin.ErrInvalid)
	}
	var used bool
	if err := tx.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM playlist_items WHERE asset_id=$1)
		OR EXISTS(SELECT 1 FROM widgets WHERE asset_id=$1)
		OR EXISTS(SELECT 1 FROM layout_draft_dependencies WHERE dependency_id=$1 AND dependency_type IN('widget','asset'))
		OR EXISTS(SELECT 1 FROM layout_revision_dependencies WHERE dependency_id=$1 AND dependency_type IN('widget','asset'))`, assetID).Scan(&used); err != nil {
		return err
	}
	if used {
		return fmt.Errorf("%w: the asset is already in use", plugin.ErrInvalid)
	}
	return nil
}

func (s pluginAssetService) ServePrivate(w http.ResponseWriter, r *http.Request, assetID uuid.UUID) error {
	if s.backend == nil {
		return errors.New("plugin assets are not configured")
	}
	delivery, err := s.backend.PrivateAssetDelivery(r.Context(), s.pluginID, assetID)
	if errors.Is(err, media.ErrVariantUnavailable) || errors.Is(err, pgx.ErrNoRows) {
		return plugin.ErrNotFound
	}
	if err != nil {
		return err
	}
	file, err := os.Open(delivery.Path)
	if err != nil {
		return plugin.ErrNotFound
	}
	defer file.Close()
	w.Header().Set("Content-Type", delivery.MIMEType)
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", media.ETag(delivery.HashHex))
	http.ServeContent(w, r, "", time.Time{}, file)
	return nil
}
