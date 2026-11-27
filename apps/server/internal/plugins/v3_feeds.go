package plugins

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Feeds of Plugin Manifest API 3 plugins (docs/plugin-feeds.md). A feed
// dataset is an ordinary Data Source row with the provider
// "<plugin>.<feed>" and the same ID as its plugin_feed_datasets row. A
// publication replaces the upstream records; operator overrides are separate
// rows; the host projects upstream, overrides, and imported images into the
// Data Source's cached payload through the normal Data Source path, so the
// Player Data Document needs nothing new.

// FeedRecordInput is one published record.
type FeedRecordInput struct {
	ID     string         `json:"id"`
	Values map[string]any `json:"values"`
}

// FeedPublication replaces the records of one dataset.
type FeedPublication struct {
	Feed string
	// Instance is the instance of a per-instance feed, uuid.Nil otherwise.
	Instance uuid.UUID
	// Replaces is the revision this publication replaces: 0 for the first.
	Replaces   int64
	Records    []FeedRecordInput
	ValidUntil *time.Time
	// Connections are the connection records remote images come through,
	// by connection declaration.
	Connections map[string]uuid.UUID
}

// FeedPublished is the answer of a publication.
type FeedPublished struct {
	Dataset      uuid.UUID `json:"dataset"`
	Revision     int64     `json:"revision"`
	Records      int       `json:"records"`
	ImagesQueued int       `json:"imagesQueued"`
}

// Feed failures.
var (
	ErrFeedInvalid  = errors.New("invalid feed publication")
	ErrFeedTooLarge = errors.New("the publication is larger than 512 KiB of canonical JSON")
)

// FeedConflictError answers a publication that names a revision other than
// the current one.
type FeedConflictError struct{ Current int64 }

func (e *FeedConflictError) Error() string {
	return fmt.Sprintf("the dataset is at revision %d", e.Current)
}

func feedInvalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrFeedInvalid, fmt.Sprintf(format, args...))
}

func (s *Service) feedPlugin(pluginID, feedID string) (hostedPlugin, plugin.Feed, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 {
		return hostedPlugin{}, plugin.Feed{}, ErrPluginNotFound
	}
	feed, ok := hosted.manifest.FeedByID(feedID)
	if !ok {
		return hostedPlugin{}, plugin.Feed{}, feedInvalid("the plugin declares no feed %q", feedID)
	}
	return hosted, feed, nil
}

type feedDataset struct {
	id          uuid.UUID
	pluginID    string
	feedID      string
	version     int
	instanceID  *uuid.UUID
	revision    int64
	publishedAt *time.Time
	validUntil  *time.Time
	connections map[string]uuid.UUID
}

const feedDatasetColumns = `id,plugin_id,feed_id,feed_version,instance_id,revision,published_at,valid_until,image_connections`

func scanFeedDataset(row pgx.Row) (feedDataset, error) {
	var out feedDataset
	var connections []byte
	err := row.Scan(&out.id, &out.pluginID, &out.feedID, &out.version, &out.instanceID, &out.revision, &out.publishedAt, &out.validUntil, &connections)
	if err == nil {
		out.connections = map[string]uuid.UUID{}
		_ = json.Unmarshal(connections, &out.connections)
	}
	return out, err
}

// canonicalRecords normalizes a publication's records and measures its
// canonical JSON: records in order, object keys sorted, no whitespace.
func (s *Service) canonicalRecords(ctx context.Context, feed plugin.Feed, records []FeedRecordInput) ([]FeedRecordInput, error) {
	if len(records) > plugin.MaxFeedRecords {
		return nil, feedInvalid("a publication holds at most %d records", plugin.MaxFeedRecords)
	}
	fields := feed.ConfigFields()
	seen := map[string]bool{}
	out := make([]FeedRecordInput, 0, len(records))
	for _, record := range records {
		if record.ID == "" || utf8.RuneCountInString(record.ID) > plugin.MaxFeedRecordIDLength || !utf8.ValidString(record.ID) {
			return nil, feedInvalid("a record ID has 1 to %d characters", plugin.MaxFeedRecordIDLength)
		}
		if seen[record.ID] {
			return nil, feedInvalid("record %q appears twice", record.ID)
		}
		seen[record.ID] = true
		values := record.Values
		if values == nil {
			values = map[string]any{}
		}
		normalized, err := configschema.Normalize(ctx, fields, values, s.configReferences())
		if err != nil {
			return nil, feedInvalid("record %q: %v", record.ID, err)
		}
		out = append(out, FeedRecordInput{ID: record.ID, Values: normalized})
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	if len(encoded) > plugin.MaxFeedPublicationBytes {
		return nil, ErrFeedTooLarge
	}
	return out, nil
}

func sameJSON(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return bytes.Equal(left, right)
}

// PublishFeed replaces the records of one dataset. It validates the whole
// publication first, then applies it in one transaction with the dataset
// row locked: the revision check, the record replacement, the override
// rules, the image queue, and the Data Source projection commit together.
// Image fetches happen after the commit.
func (s *Service) PublishFeed(ctx context.Context, pluginID string, publication FeedPublication) (FeedPublished, error) {
	hosted, feed, err := s.feedPlugin(pluginID, publication.Feed)
	if err != nil {
		return FeedPublished{}, err
	}
	records, err := s.canonicalRecords(ctx, feed, publication.Records)
	if err != nil {
		return FeedPublished{}, err
	}
	if publication.Replaces < 0 {
		return FeedPublished{}, feedInvalid("replaces is a revision, 0 or more")
	}
	if publication.ValidUntil != nil && !publication.ValidUntil.After(s.clock.Now()) {
		return FeedPublished{}, feedInvalid("validUntil must be in the future")
	}
	connections, err := s.feedImageConnections(ctx, hosted, feed, records, publication.Connections)
	if err != nil {
		return FeedPublished{}, err
	}
	var result FeedPublished
	var changes []manifestchanges.Change
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		dataset, err := s.lockFeedDataset(ctx, tx, hosted, feed, publication.Instance)
		if err != nil {
			return err
		}
		if dataset.revision != publication.Replaces {
			return &FeedConflictError{Current: dataset.revision}
		}
		queued, err := s.applyPublication(ctx, tx, hosted, feed, dataset, records)
		if err != nil {
			return err
		}
		connectionsJSON, _ := json.Marshal(connections)
		now := s.clock.Now().UTC()
		if _, err := tx.Exec(ctx, `UPDATE plugin_feed_datasets SET revision=revision+1,published_at=$2,valid_until=$3,feed_version=$4,image_connections=$5,
			expected_refresh_seconds=$6 WHERE id=$1`, dataset.id, now, publication.ValidUntil, feed.Version, connectionsJSON, feed.ExpectedRefreshSeconds); err != nil {
			return err
		}
		if err := s.queueFeedImages(ctx, tx, feed, dataset.id, dataset.revision+1, records, connections, queued); err != nil {
			return err
		}
		if changes, err = s.projectFeedDataset(ctx, tx, dataset.id, "plugin.feed.published"); err != nil {
			return err
		}
		result = FeedPublished{Dataset: dataset.id, Revision: dataset.revision + 1, Records: len(records), ImagesQueued: len(queued)}
		return s.auditFeed(ctx, tx, "plugin.feed.published", pluginID, feed, dataset.id, uuid.Nil,
			map[string]any{"revision": result.Revision, "records": result.Records})
	})
	if err != nil {
		var unique *pgconn.PgError
		if errors.As(err, &unique) && unique.Code == "23505" {
			// Two first publications raced; one created the dataset.
			return FeedPublished{}, &FeedConflictError{Current: 1}
		}
		return FeedPublished{}, err
	}
	s.notifyDataSources(changes)
	return result, nil
}

// feedImageConnections checks the connection records of image fields: each
// declaration that a record uses names a record of this plugin with that
// declaration.
func (s *Service) feedImageConnections(ctx context.Context, hosted hostedPlugin, feed plugin.Feed, records []FeedRecordInput, given map[string]uuid.UUID) (map[string]uuid.UUID, error) {
	out := map[string]uuid.UUID{}
	for _, field := range feed.Fields {
		if field.Image == nil {
			continue
		}
		used := false
		for _, record := range records {
			if text, _ := record.Values[field.Key].(string); text != "" {
				used = true
				break
			}
		}
		if !used {
			continue
		}
		id, ok := given[field.Image.Connection]
		if !ok || id == uuid.Nil {
			return nil, feedInvalid("field %q needs a connection record of declaration %q", field.Key, field.Image.Connection)
		}
		var definition string
		err := s.db.QueryRow(ctx, `SELECT definition_id FROM plugin_connections WHERE id=$1 AND plugin_id=$2`, id, hosted.manifest.ID).Scan(&definition)
		if err != nil || definition != field.Image.Connection {
			return nil, feedInvalid("connection %s is not a %q connection of this plugin", id, field.Image.Connection)
		}
		out[field.Image.Connection] = id
	}
	return out, nil
}

// lockFeedDataset locks a dataset, or creates it with its Data Source row
// at the first publication.
func (s *Service) lockFeedDataset(ctx context.Context, tx pgx.Tx, hosted hostedPlugin, feed plugin.Feed, instance uuid.UUID) (feedDataset, error) {
	pluginID := hosted.manifest.ID
	var instanceID *uuid.UUID
	instanceName := ""
	switch feed.Dataset {
	case plugin.FeedDatasetInstance:
		if instance == uuid.Nil {
			return feedDataset{}, feedInvalid("feed %q has a dataset for each instance; name the instance", feed.ID)
		}
		err := tx.QueryRow(ctx, `SELECT name FROM plugin_instances WHERE id=$1 AND plugin_id=$2 AND kind=$3 FOR SHARE`, instance, pluginID, feed.InstanceKind).Scan(&instanceName)
		if errors.Is(err, pgx.ErrNoRows) {
			return feedDataset{}, feedInvalid("instance %s is not a %q instance of this plugin", instance, feed.InstanceKind)
		}
		if err != nil {
			return feedDataset{}, err
		}
		instanceID = &instance
	default:
		if instance != uuid.Nil {
			return feedDataset{}, feedInvalid("feed %q has one organization dataset; name no instance", feed.ID)
		}
	}
	dataset, err := scanFeedDataset(tx.QueryRow(ctx, `SELECT `+feedDatasetColumns+` FROM plugin_feed_datasets
		WHERE plugin_id=$1 AND feed_id=$2 AND instance_id IS NOT DISTINCT FROM $3 FOR UPDATE`, pluginID, feed.ID, instanceID))
	if err == nil {
		return dataset, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return feedDataset{}, err
	}
	name := hosted.manifest.Name + ": " + feed.Title
	if instanceName != "" {
		name = instanceName + ": " + feed.Title
	}
	if utf8.RuneCountInString(name) > 180 {
		name = string([]rune(name)[:180])
	}
	id := uuid.New()
	configuration, _ := json.Marshal(map[string]string{"plugin": pluginID, "feed": feed.ID})
	if _, err := tx.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration)
		SELECT $1,id,$2,$3,$4,1,$5::jsonb FROM organization_settings WHERE singleton`,
		id, name, feed.Description, feed.ProviderID(pluginID), string(configuration)); err != nil {
		return feedDataset{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at) VALUES($1,now()+interval '100 years')`, id); err != nil {
		return feedDataset{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO plugin_feed_datasets(id,plugin_id,feed_id,feed_version,instance_id,expected_refresh_seconds) VALUES($1,$2,$3,$4,$5,$6)`,
		id, pluginID, feed.ID, feed.Version, instanceID, feed.ExpectedRefreshSeconds); err != nil {
		return feedDataset{}, err
	}
	return feedDataset{id: id, pluginID: pluginID, feedID: feed.ID, version: feed.Version, instanceID: instanceID, connections: map[string]uuid.UUID{}}, nil
}

// applyPublication replaces the records and applies the override rules. It
// returns the image fields that need an import, keyed "record\x00field".
func (s *Service) applyPublication(ctx context.Context, tx pgx.Tx, hosted hostedPlugin, feed plugin.Feed, dataset feedDataset, records []FeedRecordInput) (map[string]bool, error) {
	pluginID := hosted.manifest.ID
	old := map[string]map[string]any{}
	rows, err := tx.Query(ctx, `SELECT record_id,upstream FROM plugin_feed_records WHERE dataset_id=$1`, dataset.id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		values := map[string]any{}
		_ = json.Unmarshal(raw, &values)
		old[id] = values
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	overrides, err := feedOverrideKeys(ctx, tx, dataset.id)
	if err != nil {
		return nil, err
	}
	if dataset.version != feed.Version {
		// A new feed version is a new schema: no override carries over.
		for _, key := range overrides {
			if err := s.removeOverride(ctx, tx, pluginID, feed, dataset.id, key.record, key.field, "feed_version_changed", true); err != nil {
				return nil, err
			}
		}
		overrides = nil
	}
	current := map[string]bool{}
	for _, record := range records {
		current[record.ID] = true
	}
	for _, key := range overrides {
		if !current[key.record] {
			// The record left the publication: its overrides go with it.
			if err := s.auditFeed(ctx, tx, "plugin.feed.override_removed", pluginID, feed, dataset.id, uuid.Nil,
				map[string]any{"recordId": key.record, "field": key.field, "reason": "record_removed"}); err != nil {
				return nil, err
			}
			continue
		}
		field, ok := feedField(feed, key.field)
		if !ok {
			continue
		}
		if field.OverridePolicy() == plugin.OverrideLocalUntilChanged {
			before, after := old[key.record][key.field], findRecord(records, key.record)[key.field]
			// The rule compares the raw upstream values, never the effective
			// value: an unchanged upstream keeps the override.
			if !sameJSON(before, after) {
				if err := s.removeOverride(ctx, tx, pluginID, feed, dataset.id, key.record, key.field, "upstream_changed", false); err != nil {
					return nil, err
				}
			}
		}
	}
	removed := make([]string, 0)
	for id := range old {
		if !current[id] {
			removed = append(removed, id)
		}
	}
	if len(removed) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_feed_records WHERE dataset_id=$1 AND record_id=ANY($2)`, dataset.id, removed); err != nil {
			return nil, err
		}
	}
	queued := map[string]bool{}
	for position, record := range records {
		encoded, _ := json.Marshal(record.Values)
		before, existed := old[record.ID]
		if existed && sameJSON(before, record.Values) {
			if _, err := tx.Exec(ctx, `UPDATE plugin_feed_records SET position=$3 WHERE dataset_id=$1 AND record_id=$2`, dataset.id, record.ID, position); err != nil {
				return nil, err
			}
		} else if _, err := tx.Exec(ctx, `INSERT INTO plugin_feed_records(dataset_id,record_id,position,upstream,updated_at) VALUES($1,$2,$3,$4,$5)
			ON CONFLICT (dataset_id,record_id) DO UPDATE SET position=EXCLUDED.position,upstream=EXCLUDED.upstream,updated_at=EXCLUDED.updated_at`,
			dataset.id, record.ID, position, encoded, s.clock.Now().UTC()); err != nil {
			return nil, err
		}
		for _, field := range feed.Fields {
			if field.Image == nil {
				continue
			}
			value, _ := record.Values[field.Key].(string)
			var source string
			err := tx.QueryRow(ctx, `SELECT source_url FROM plugin_feed_assets WHERE dataset_id=$1 AND record_id=$2 AND field_key=$3`,
				dataset.id, record.ID, field.Key).Scan(&source)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
			if value != "" && source == value {
				continue
			}
			// A new or removed URL: the old image no longer applies.
			for _, statement := range []string{
				`DELETE FROM plugin_feed_assets WHERE dataset_id=$1 AND record_id=$2 AND field_key=$3`,
				`DELETE FROM plugin_feed_image_failures WHERE dataset_id=$1 AND record_id=$2 AND field_key=$3`,
				`DELETE FROM plugin_feed_image_imports WHERE dataset_id=$1 AND record_id=$2 AND field_key=$3`,
			} {
				if _, err := tx.Exec(ctx, statement, dataset.id, record.ID, field.Key); err != nil {
					return nil, err
				}
			}
			if value != "" {
				queued[record.ID+"\x00"+field.Key] = true
			}
		}
	}
	return queued, nil
}

type overrideKey struct{ record, field string }

func feedOverrideKeys(ctx context.Context, tx pgx.Tx, datasetID uuid.UUID) ([]overrideKey, error) {
	rows, err := tx.Query(ctx, `SELECT record_id,field_key FROM plugin_feed_overrides WHERE dataset_id=$1 ORDER BY record_id,field_key`, datasetID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (overrideKey, error) {
		var key overrideKey
		return key, row.Scan(&key.record, &key.field)
	})
}

func findRecord(records []FeedRecordInput, id string) map[string]any {
	for _, record := range records {
		if record.ID == id {
			return record.Values
		}
	}
	return nil
}

func feedField(feed plugin.Feed, key string) (plugin.FeedField, bool) {
	for _, field := range feed.Fields {
		if field.Key == key {
			return field, true
		}
	}
	return plugin.FeedField{}, false
}

// removeOverride deletes one override, records why for Studio, and writes a
// bounded audit event: plugin, feed, dataset, record, field, reason. It
// never records a value.
func (s *Service) removeOverride(ctx context.Context, tx pgx.Tx, pluginID string, feed plugin.Feed, datasetID uuid.UUID, recordID, field, reason string, recordGone bool) error {
	if _, err := tx.Exec(ctx, `DELETE FROM plugin_feed_overrides WHERE dataset_id=$1 AND record_id=$2 AND field_key=$3`, datasetID, recordID, field); err != nil {
		return err
	}
	if !recordGone {
		if _, err := tx.Exec(ctx, `INSERT INTO plugin_feed_override_removals(dataset_id,record_id,field_key,reason,removed_at) VALUES($1,$2,$3,$4,$5)
			ON CONFLICT (dataset_id,record_id,field_key) DO UPDATE SET reason=EXCLUDED.reason,removed_at=EXCLUDED.removed_at`,
			datasetID, recordID, field, reason, s.clock.Now().UTC()); err != nil {
			return err
		}
	}
	return s.auditFeed(ctx, tx, "plugin.feed.override_removed", pluginID, feed, datasetID, uuid.Nil,
		map[string]any{"recordId": recordID, "field": field, "reason": reason})
}

func (s *Service) auditFeed(ctx context.Context, tx pgx.Tx, action, pluginID string, feed plugin.Feed, datasetID, userID uuid.UUID, metadata map[string]any) error {
	metadata["feed"] = feed.Ref()
	return s.auditPluginResource(ctx, tx, action, "plugin_feed_dataset", pluginID, datasetID, feed.Title, userID, metadata)
}

// projectFeedDataset writes the effective records into the Data Source's
// cached payload and invalidates the screens that use it.
func (s *Service) projectFeedDataset(ctx context.Context, tx pgx.Tx, datasetID uuid.UUID, reason string) ([]manifestchanges.Change, error) {
	dataset, err := scanFeedDataset(tx.QueryRow(ctx, `SELECT `+feedDatasetColumns+` FROM plugin_feed_datasets WHERE id=$1`, datasetID))
	if err != nil {
		return nil, err
	}
	hosted, feed, err := s.feedPlugin(dataset.pluginID, dataset.feedID)
	if err != nil {
		return nil, err
	}
	records, err := s.effectiveRecords(ctx, tx, feed, datasetID)
	if err != nil {
		return nil, err
	}
	typed := plugin.TypedDataset{ID: feed.ID, Kind: "records", Fields: feedDocumentFields(feed), Records: make([]plugin.TypedRecord, 0, len(records)),
		CachedAt: dataset.publishedAt, StaleAt: dataset.validUntil}
	for _, record := range records {
		values := map[string]string{}
		for _, field := range feed.Fields {
			values[field.Key] = record.Effective[field.Key]
		}
		typed.Records = append(typed.Records, plugin.TypedRecord{ID: record.ID, Values: values})
	}
	payload, err := json.Marshal(plugin.TypedDatasetPayload{Datasets: []plugin.TypedDataset{typed}})
	if err != nil {
		return nil, err
	}
	expires := "now()+interval '100 years'"
	args := []any{datasetID, string(payload), len(typed.Records), dataset.publishedAt}
	if dataset.validUntil != nil {
		expires = "$5"
		args = append(args, *dataset.validUntil)
	}
	if _, err := tx.Exec(ctx, `UPDATE data_source_refresh_states SET next_refresh_at=now()+interval '100 years',
		last_attempt_at=COALESCE($4,now()),last_success_at=$4,http_result_category='manual',parse_status='success',
		available_item_count=$3,using_cached_data=FALSE,cache_updated_at=COALESCE($4,now()),cache_expires_at=`+expires+`,
		cached_payload=$2::jsonb,error_code=NULL,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE data_source_id=$1`, args...); err != nil {
		return nil, err
	}
	_ = hosted
	if s.dsInvalidator == nil {
		return nil, nil
	}
	return s.dsInvalidator.DataSourceChangedInTx(ctx, tx, datasetID, reason)
}

func (s *Service) notifyDataSources(changes []manifestchanges.Change) {
	if s.dsInvalidator != nil && len(changes) > 0 {
		s.dsInvalidator.NotifyManifestChanges(changes)
	}
}

func feedDocumentFields(feed plugin.Feed) []plugin.DataSourceField {
	out := make([]plugin.DataSourceField, 0, len(feed.Fields))
	for _, field := range feed.Fields {
		out = append(out, plugin.DataSourceField{Key: field.Key, Label: field.Label, Type: field.DocumentType()})
	}
	return out
}

// FeedRecordDocument is one record as Studio shows it: the upstream value,
// the operator's override, the effective value, and the policy of each
// field, with the reason an override was removed.
type FeedRecordDocument struct {
	ID        string                     `json:"id"`
	Upstream  map[string]any             `json:"upstream"`
	Overrides map[string]any             `json:"overrides"`
	Effective map[string]string          `json:"effective"`
	Removed   map[string]OverrideRemoval `json:"removedOverrides"`
	// ImageFailures are the stable codes of failed image imports.
	ImageFailures map[string]string `json:"imageFailures"`
}

// OverrideRemoval says why the host removed an override.
type OverrideRemoval struct {
	Reason    string    `json:"reason"`
	RemovedAt time.Time `json:"removedAt"`
}

func feedText(field plugin.FeedField, value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case json.Number:
		return typed.String()
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func (s *Service) effectiveRecords(ctx context.Context, q queryer, feed plugin.Feed, datasetID uuid.UUID) ([]FeedRecordDocument, error) {
	rows, err := q.Query(ctx, `SELECT record_id,upstream FROM plugin_feed_records WHERE dataset_id=$1 ORDER BY position,record_id`, datasetID)
	if err != nil {
		return nil, err
	}
	records := []FeedRecordDocument{}
	index := map[string]int{}
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		upstream := map[string]any{}
		_ = decoder.Decode(&upstream)
		index[id] = len(records)
		records = append(records, FeedRecordDocument{ID: id, Upstream: upstream, Overrides: map[string]any{}, Effective: map[string]string{},
			Removed: map[string]OverrideRemoval{}, ImageFailures: map[string]string{}})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	attach := func(sql string, scan func(pgx.Rows) error) error {
		rows, err := q.Query(ctx, sql, datasetID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := scan(rows); err != nil {
				return err
			}
		}
		return rows.Err()
	}
	assets := map[string]string{}
	if err := attach(`SELECT record_id,field_key,value FROM plugin_feed_overrides WHERE dataset_id=$1`, func(rows pgx.Rows) error {
		var record, field string
		var raw []byte
		if err := rows.Scan(&record, &field, &raw); err != nil {
			return err
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var value any
		_ = decoder.Decode(&value)
		if i, ok := index[record]; ok {
			records[i].Overrides[field] = value
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if err := attach(`SELECT record_id,field_key,reason,removed_at FROM plugin_feed_override_removals WHERE dataset_id=$1`, func(rows pgx.Rows) error {
		var record, field string
		var removal OverrideRemoval
		if err := rows.Scan(&record, &field, &removal.Reason, &removal.RemovedAt); err != nil {
			return err
		}
		if i, ok := index[record]; ok {
			records[i].Removed[field] = removal
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if err := attach(`SELECT record_id,field_key,asset_id FROM plugin_feed_assets WHERE dataset_id=$1`, func(rows pgx.Rows) error {
		var record, field string
		var asset uuid.UUID
		if err := rows.Scan(&record, &field, &asset); err != nil {
			return err
		}
		assets[record+"\x00"+field] = asset.String()
		return nil
	}); err != nil {
		return nil, err
	}
	if err := attach(`SELECT record_id,field_key,code FROM plugin_feed_image_failures WHERE dataset_id=$1`, func(rows pgx.Rows) error {
		var record, field, code string
		if err := rows.Scan(&record, &field, &code); err != nil {
			return err
		}
		if i, ok := index[record]; ok {
			records[i].ImageFailures[field] = code
		}
		return nil
	}); err != nil {
		return nil, err
	}
	for i := range records {
		record := &records[i]
		for _, field := range feed.Fields {
			switch {
			case field.Image != nil:
				record.Effective[field.Key] = assets[record.ID+"\x00"+field.Key]
			default:
				value := record.Upstream[field.Key]
				if override, ok := record.Overrides[field.Key]; ok && field.OverridePolicy() != plugin.OverrideUpstream {
					value = override
				}
				record.Effective[field.Key] = feedText(field, value)
			}
		}
	}
	return records, nil
}

// feedProvider is the host-owned Data Source provider of one feed. It is
// not plugin code: every feed of every plugin uses this one type.
type feedProvider struct {
	pluginID   string
	pluginName string
	route      string
	feed       plugin.Feed
}

var _ plugin.DataSourceProvider = feedProvider{}

func (p feedProvider) ProviderID() string { return p.feed.ProviderID(p.pluginID) }

func (p feedProvider) Traits() plugin.DataSourceTraits {
	temporal, numeric := false, false
	for _, field := range p.feed.Fields {
		switch field.Control {
		case "date", "datetime":
			temporal = true
		case "number", "integer":
			numeric = true
		}
	}
	return plugin.DataSourceTraits{RecordBased: true, Temporal: temporal, Numeric: numeric, ProducesFields: true}
}

func (p feedProvider) NormalizeConfiguration(raw json.RawMessage) (json.RawMessage, error) {
	var configuration struct {
		Plugin string `json:"plugin"`
		Feed   string `json:"feed"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&configuration); err != nil || configuration.Plugin != p.pluginID || configuration.Feed != p.feed.ID {
		return nil, errors.New("a feed Data Source is managed by its plugin")
	}
	return json.Marshal(configuration)
}

func (p feedProvider) FieldsFromConfig(json.RawMessage) []plugin.DataSourceField {
	return feedDocumentFields(p.feed)
}

func (p feedProvider) Catalog() (string, string, string) {
	description := p.feed.Description
	if description == "" {
		description = "Records that the " + p.pluginName + " plugin publishes."
	}
	return p.feed.Title, p.pluginName, description
}

func (p feedProvider) CanonicalEditor() string  { return p.route + "/feeds/:id" }
func (p feedProvider) CanonicalCreator() string { return "" }
func (p feedProvider) ManagedExternally() bool  { return true }
func (p feedProvider) HiddenFromGallery() bool  { return true }

func (p feedProvider) ExternalMessage(action string) string {
	return "The " + p.pluginName + " plugin publishes this Data Source. Its records change only through the plugin; edit a field override on the plugin's feed page."
}

// feedProviders returns the host-owned provider of every declared feed.
func (s *Service) feedProviders() []plugin.DataSourceProvider {
	out := []plugin.DataSourceProvider{}
	for _, hosted := range s.hosted {
		if hosted.manifest.APIVersion < 3 {
			continue
		}
		for _, feed := range hosted.manifest.Feeds {
			out = append(out, feedProvider{pluginID: hosted.manifest.ID, pluginName: hosted.manifest.Name, route: hosted.manifest.StudioRoute(), feed: feed})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ProviderID() < out[j].ProviderID() })
	return out
}

// feedServiceFailure maps a feed error to an API error.
func feedAPIError(err error) error {
	var conflict *FeedConflictError
	switch {
	case errors.As(err, &conflict):
		return &plugin.APIError{Status: http.StatusConflict, Code: "plugin_feed_revision_conflict", Message: "The records changed since you loaded them.",
			Details: map[string]any{"currentRevision": conflict.Current}}
	case errors.Is(err, ErrFeedInvalid):
		return &plugin.APIError{Status: http.StatusBadRequest, Code: "invalid_plugin_feed", Message: strings.TrimPrefix(err.Error(), ErrFeedInvalid.Error()+": ")}
	}
	return err
}

// FeedRevision returns the current revision of a dataset: 0 before the
// first publication.
func (s *Service) FeedRevision(ctx context.Context, pluginID, feedID string, instance uuid.UUID) (int64, error) {
	_, feed, err := s.feedPlugin(pluginID, feedID)
	if err != nil {
		return 0, err
	}
	if (feed.Dataset == plugin.FeedDatasetInstance) != (instance != uuid.Nil) {
		return 0, feedInvalid("feed %q needs an instance only for a dataset of each instance", feedID)
	}
	var instanceID *uuid.UUID
	if instance != uuid.Nil {
		instanceID = &instance
	}
	var revision int64
	err = s.db.QueryRow(ctx, `SELECT revision FROM plugin_feed_datasets WHERE plugin_id=$1 AND feed_id=$2 AND instance_id IS NOT DISTINCT FROM $3`,
		pluginID, feedID, instanceID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return revision, err
}
