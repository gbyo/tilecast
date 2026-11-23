package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Host-owned instances of Plugin Manifest API 3 plugins. The host owns
// storage, revisions, targets, schedules, authorization, audit, font and
// media references, secrets, and manifest invalidation. A plugin judges the
// domain meaning of an instance through InstanceValidator and nothing else.

const instanceColumns = `id,kind,name,enabled,priority,target_scope,schedule,configuration,revision,created_at,updated_at`

type instanceRow struct {
	id            uuid.UUID
	kind          string
	name          string
	enabled       bool
	priority      int
	targetScope   *string
	schedule      *plugin.InstanceSchedule
	configuration map[string]any
	revision      int64
	createdAt     time.Time
	updatedAt     time.Time
	targetIDs     []uuid.UUID
}

func scanInstance(row pgx.Row) (instanceRow, error) {
	var item instanceRow
	var schedule, configuration []byte
	err := row.Scan(&item.id, &item.kind, &item.name, &item.enabled, &item.priority, &item.targetScope, &schedule, &configuration, &item.revision, &item.createdAt, &item.updatedAt)
	if err != nil {
		return item, err
	}
	if len(schedule) > 0 {
		item.schedule = &plugin.InstanceSchedule{}
		if err := json.Unmarshal(schedule, item.schedule); err != nil {
			return item, err
		}
	}
	item.configuration = map[string]any{}
	err = json.Unmarshal(configuration, &item.configuration)
	return item, err
}

func (row instanceRow) target() plugin.Target {
	if row.targetScope == nil {
		return plugin.Target{}
	}
	ids := row.targetIDs
	if ids == nil {
		ids = []uuid.UUID{}
	}
	return plugin.Target{Scope: *row.targetScope, IDs: ids}
}

func (row instanceRow) hosted(kind plugin.InstanceKind) plugin.HostedInstance {
	return plugin.HostedInstance{ID: row.id, Kind: row.kind, Name: row.name, Enabled: row.enabled, Priority: row.priority,
		Revision: row.revision, Target: row.target(), Schedule: row.schedule, Configuration: row.configuration}
}

type queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func readTargets(ctx context.Context, q queryer, id uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx, `SELECT target_id FROM plugin_instance_targets WHERE instance_id=$1 ORDER BY target_id`, id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// v3Plugin resolves a hosted API 3 plugin and one of its kinds.
func (s *Service) v3Kind(pluginID, kind string) (hostedPlugin, plugin.InstanceKind, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || !hosted.manifest.HostOwnsInstances() {
		return hostedPlugin{}, plugin.InstanceKind{}, ErrPluginNotFound
	}
	declared, ok := hosted.manifest.InstanceKindByName(kind)
	if !ok {
		return hostedPlugin{}, plugin.InstanceKind{}, ErrNotFound
	}
	return hosted, declared, nil
}

func (s *Service) document(ctx context.Context, q queryer, hosted hostedPlugin, kind plugin.InstanceKind, row instanceRow) (InstanceDocument, error) {
	document := InstanceDocument{ID: row.id, Kind: row.kind, Name: row.name, Enabled: row.enabled, Revision: row.revision,
		Configuration: row.configuration, CreatedAt: row.createdAt, UpdatedAt: row.updatedAt}
	if kind.Priority != nil {
		priority := row.priority
		document.Priority = &priority
	}
	if kind.Targeting == plugin.TargetingScreens && row.targetScope != nil {
		document.TargetScope = row.targetScope
		document.TargetIDs = row.targetIDs
	}
	if kind.Schedule != plugin.ScheduleNone {
		document.Schedule = row.schedule
	}
	if keys := configschema.SecretKeys(kind.Fields); len(keys) > 0 {
		if s.secrets == nil {
			document.Secrets = map[string]pluginsecrets.State{}
			for _, key := range keys {
				document.Secrets[key] = pluginsecrets.StateNeedsValue
			}
		} else {
			states, err := s.secrets.States(ctx, q, hosted.manifest.ID, pluginsecrets.OwnerInstance, row.id, keys)
			if err != nil {
				return InstanceDocument{}, err
			}
			document.Secrets = states
		}
	}
	return document, nil
}

// ListInstances returns a kind's instances, strongest priority first.
func (s *Service) ListInstances(ctx context.Context, pluginID, kind string) ([]InstanceDocument, error) {
	hosted, declared, err := s.v3Kind(pluginID, kind)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+instanceColumns+` FROM plugin_instances WHERE plugin_id=$1 AND kind=$2 ORDER BY priority DESC,lower(name),id`, pluginID, kind)
	if err != nil {
		return nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (instanceRow, error) { return scanInstance(row) })
	if err != nil {
		return nil, err
	}
	out := make([]InstanceDocument, 0, len(items))
	// Targets are read after the instance cursor is drained, so a listing
	// needs one pooled connection at a time.
	for _, item := range items {
		if item.targetIDs, err = readTargets(ctx, s.db, item.id); err != nil {
			return nil, err
		}
		document, err := s.document(ctx, s.db, hosted, declared, item)
		if err != nil {
			return nil, err
		}
		out = append(out, document)
	}
	return out, nil
}

// GetInstance returns one instance or ErrNotFound.
func (s *Service) GetInstance(ctx context.Context, pluginID, kind string, id uuid.UUID) (InstanceDocument, error) {
	hosted, declared, err := s.v3Kind(pluginID, kind)
	if err != nil {
		return InstanceDocument{}, err
	}
	row, err := scanInstance(s.db.QueryRow(ctx, `SELECT `+instanceColumns+` FROM plugin_instances WHERE id=$1 AND plugin_id=$2 AND kind=$3`, id, pluginID, kind))
	if errors.Is(err, pgx.ErrNoRows) {
		return InstanceDocument{}, ErrNotFound
	}
	if err != nil {
		return InstanceDocument{}, err
	}
	if row.targetIDs, err = readTargets(ctx, s.db, id); err != nil {
		return InstanceDocument{}, err
	}
	return s.document(ctx, s.db, hosted, declared, row)
}

// preparedInstance is a validated write, ready to store.
type preparedInstance struct {
	name          string
	enabled       bool
	priority      int
	target        *plugin.Target
	schedule      *plugin.InstanceSchedule
	configuration map[string]any
	secrets       map[string]string
	clear         []string
}

// prepareInstance validates a write against the kind. current is nil on
// create. It reads nothing the transaction must lock.
func (s *Service) prepareInstance(ctx context.Context, hosted hostedPlugin, kind plugin.InstanceKind, write instanceWrite, current *instanceRow) (preparedInstance, error) {
	var out preparedInstance
	var err error
	if out.name, err = normalizeInstanceName(write.Name); err != nil {
		return out, err
	}
	out.enabled = true
	if current != nil {
		out.enabled = current.enabled
	}
	if write.Enabled != nil {
		out.enabled = *write.Enabled
	}
	switch {
	case kind.Priority == nil && write.Priority != nil:
		return out, plugin.Invalidf("this kind has no priority")
	case kind.Priority != nil:
		out.priority = kind.Priority.Default
		if current != nil {
			out.priority = current.priority
		}
		if write.Priority != nil {
			out.priority = *write.Priority
		}
		if out.priority < kind.Priority.Minimum || out.priority > kind.Priority.Maximum {
			return out, plugin.Invalidf("priority must be between %d and %d", kind.Priority.Minimum, kind.Priority.Maximum)
		}
	}
	switch kind.Targeting {
	case plugin.TargetingScreens:
		if write.Target == nil {
			return out, plugin.Invalidf("targetScope and targetIds are required")
		}
		if err := write.Target.Validate(); err != nil {
			return out, err
		}
		out.target = write.Target
	default:
		if write.Target != nil {
			return out, plugin.Invalidf("this kind has no screen targets")
		}
	}
	if out.schedule, err = validateSchedule(kind.Schedule, write.Schedule); err != nil {
		return out, err
	}
	out.configuration, err = configschema.Normalize(ctx, kind.Fields, write.Configuration, s.pluginConfigReferences(hosted.manifest.ID))
	if err != nil {
		return out, fmt.Errorf("%w: %v", plugin.ErrInvalid, err)
	}
	secretFields := map[string]configschema.Field{}
	for _, field := range kind.Fields {
		if field.Control == configschema.ControlSecret {
			secretFields[field.Key] = field
		}
	}
	out.secrets = map[string]string{}
	for key, value := range write.Secrets {
		field, ok := secretFields[key]
		if !ok {
			return out, plugin.Invalidf("%s is not a secret field of this kind", key)
		}
		normalized, err := configschema.NormalizeSecret(field, value)
		if err != nil {
			return out, fmt.Errorf("%w: %v", plugin.ErrInvalid, err)
		}
		out.secrets[key] = normalized
	}
	for _, key := range write.ClearSecrets {
		if _, ok := secretFields[key]; !ok {
			return out, plugin.Invalidf("%s is not a secret field of this kind", key)
		}
		if _, set := out.secrets[key]; set {
			return out, plugin.Invalidf("%s cannot be set and cleared in one request", key)
		}
		out.clear = append(out.clear, key)
	}
	if (len(out.secrets) > 0 || len(out.clear) > 0) && s.secrets == nil {
		return out, &plugin.APIError{Status: 503, Code: "secrets_unavailable", Message: "Plugin secrets are unavailable on this server."}
	}
	if validator, ok := hosted.plugin.(plugin.InstanceValidator); ok {
		id := uuid.Nil
		var revision int64
		if current != nil {
			id, revision = current.id, current.revision
		}
		target := plugin.Target{}
		if out.target != nil {
			target = *out.target
		}
		hostedInstance := plugin.HostedInstance{ID: id, Kind: kind.Kind, Name: out.name, Enabled: out.enabled, Priority: out.priority,
			Revision: revision, Target: target, Schedule: out.schedule, Configuration: out.configuration}
		invocationCtx, done := s.operatorInvocation(ctx, hosted.manifest.ID)
		err := validator.ValidateInstance(invocationCtx, hostedInstance)
		done()
		if err != nil {
			if errors.Is(err, plugin.ErrInvalid) {
				return out, err
			}
			return out, fmt.Errorf("%w: %v", plugin.ErrInvalid, err)
		}
	}
	return out, nil
}

// requiredSecretsSet refuses a write that leaves a required secret unset.
func (s *Service) requiredSecretsSet(ctx context.Context, tx pgx.Tx, pluginID, ownerType string, ownerID uuid.UUID, fields []configschema.Field, secrets map[string]string, clear []string) error {
	for _, field := range fields {
		if field.Control != configschema.ControlSecret || !field.Required {
			continue
		}
		if _, set := secrets[field.Key]; set {
			continue
		}
		cleared := false
		for _, key := range clear {
			cleared = cleared || key == field.Key
		}
		var exists bool
		if !cleared && s.secrets != nil {
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plugin_secrets WHERE plugin_id=$1 AND owner_type=$2 AND owner_id=$3 AND setting_key=$4)`,
				pluginID, ownerType, ownerID, field.Key).Scan(&exists); err != nil {
				return err
			}
		}
		if !exists {
			return plugin.Invalidf("%s is required", field.Label)
		}
	}
	return nil
}

// CreateInstance stores a new instance. The plugin must be installed.
func (s *Service) CreateInstance(ctx context.Context, pluginID, kindName string, userID uuid.UUID, write instanceWrite) (InstanceDocument, error) {
	hosted, kind, err := s.v3Kind(pluginID, kindName)
	if err != nil {
		return InstanceDocument{}, err
	}
	prepared, err := s.prepareInstance(ctx, hosted, kind, write, nil)
	if err != nil {
		return InstanceDocument{}, err
	}
	// Read host facts before the transaction: a pool read while tx holds a
	// connection needs a second one.
	organizationID, err := organizationService{service: s}.ID(ctx)
	if err != nil {
		return InstanceDocument{}, err
	}
	id := uuid.New()
	notes, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		if err := s.lockInstallation(ctx, tx, pluginID); err != nil {
			return nil, err
		}
		if err := s.checkNewTarget(ctx, tx, prepared.target); err != nil {
			return nil, err
		}
		if err := s.requiredSecretsSet(ctx, tx, pluginID, pluginsecrets.OwnerInstance, id, kind.Fields, prepared.secrets, prepared.clear); err != nil {
			return nil, err
		}
		if err := s.insertInstance(ctx, tx, organizationID, pluginID, kind, id, userID, prepared); err != nil {
			return nil, err
		}
		if err := s.storeInstanceResources(ctx, tx, hosted, kind, id, userID, prepared); err != nil {
			return nil, err
		}
		changed := changedKeys(nil, prepared.configuration)
		if err := s.auditInstance(ctx, tx, "plugin.instance.created", hosted, kind, id, prepared.name, userID, changed, prepared); err != nil {
			return nil, err
		}
		return s.invalidateInstance(ctx, tx, hosted, kind, nil, prepared.target, "plugin.instance.created")
	})
	if err != nil {
		return InstanceDocument{}, err
	}
	s.notify(notes)
	return s.GetInstance(ctx, pluginID, kindName, id)
}

// UpdateInstance replaces an instance when expectedRevision is current.
// The comparison and the change are one transaction holding the row lock,
// so a stale write changes nothing: not the configuration, the targets, the
// schedule, the secrets, or the references.
func (s *Service) UpdateInstance(ctx context.Context, pluginID, kindName string, id, userID uuid.UUID, write instanceWrite) (InstanceDocument, error) {
	hosted, kind, err := s.v3Kind(pluginID, kindName)
	if err != nil {
		return InstanceDocument{}, err
	}
	if write.ExpectedRevision == nil {
		return InstanceDocument{}, revisionRequiredError()
	}
	current, err := s.GetInstance(ctx, pluginID, kindName, id)
	if err != nil {
		return InstanceDocument{}, err
	}
	if current.Revision != *write.ExpectedRevision {
		return InstanceDocument{}, conflictError(current.Revision)
	}
	currentRow := instanceRow{id: current.ID, enabled: current.Enabled, revision: current.Revision}
	if current.Priority != nil {
		currentRow.priority = *current.Priority
	}
	prepared, err := s.prepareInstance(ctx, hosted, kind, write, &currentRow)
	if err != nil {
		return InstanceDocument{}, err
	}
	notes, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		if err := s.lockInstallation(ctx, tx, pluginID); err != nil {
			return nil, err
		}
		stored, err := scanInstance(tx.QueryRow(ctx, `SELECT `+instanceColumns+` FROM plugin_instances WHERE id=$1 AND plugin_id=$2 AND kind=$3 FOR UPDATE`, id, pluginID, kindName))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if stored.revision != *write.ExpectedRevision {
			return nil, conflictError(stored.revision)
		}
		if stored.targetIDs, err = readTargets(ctx, tx, id); err != nil {
			return nil, err
		}
		var storedTarget *plugin.Target
		if stored.targetScope != nil {
			target := stored.target()
			storedTarget = &target
			// An operator may change an instance only when it can target both
			// the screens the instance reaches now and the ones it will reach.
			if err := s.authorizeTarget(ctx, tx, target); err != nil {
				return nil, err
			}
		}
		if err := s.checkNewTarget(ctx, tx, prepared.target); err != nil {
			return nil, err
		}
		if err := s.requiredSecretsSet(ctx, tx, pluginID, pluginsecrets.OwnerInstance, id, kind.Fields, prepared.secrets, prepared.clear); err != nil {
			return nil, err
		}
		schedule, next := scheduleColumns(prepared.schedule, s.clock.Now())
		configuration, err := json.Marshal(prepared.configuration)
		if err != nil {
			return nil, err
		}
		var scope *string
		if prepared.target != nil {
			scope = &prepared.target.Scope
		}
		personal := personalWrites(kind.Fields, stored.configuration, prepared.configuration, s.clock.Now())
		tag, err := tx.Exec(ctx, `UPDATE plugin_instances SET name=$4,enabled=$5,priority=$6,target_scope=$7,schedule=$8,next_schedule_change_at=$9,
			configuration=$10,personal_written_at=personal_written_at||$11::jsonb,revision=revision+1,updated_by=$12,updated_at=now()
			WHERE id=$1 AND plugin_id=$2 AND revision=$3`,
			id, pluginID, stored.revision, prepared.name, prepared.enabled, prepared.priority, scope, schedule, next, configuration, personal, userID)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() != 1 {
			return nil, conflictError(stored.revision)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_instance_targets WHERE instance_id=$1`, id); err != nil {
			return nil, err
		}
		if err := insertTargets(ctx, tx, id, prepared.target); err != nil {
			return nil, err
		}
		if err := s.storeInstanceResources(ctx, tx, hosted, kind, id, userID, prepared); err != nil {
			return nil, err
		}
		changed := changedKeys(stored.configuration, prepared.configuration)
		for member, differs := range map[string]bool{
			"name": stored.name != prepared.name, "enabled": stored.enabled != prepared.enabled,
			"priority": kind.Priority != nil && stored.priority != prepared.priority,
			"targets":  !sameTarget(storedTarget, prepared.target),
			"schedule": !sameSchedule(stored.schedule, prepared.schedule),
		} {
			if differs {
				changed = append(changed, member)
			}
		}
		if err := s.auditInstance(ctx, tx, "plugin.instance.updated", hosted, kind, id, prepared.name, userID, changed, prepared); err != nil {
			return nil, err
		}
		return s.invalidateInstance(ctx, tx, hosted, kind, storedTarget, prepared.target, "plugin.instance.updated")
	})
	if err != nil {
		return InstanceDocument{}, err
	}
	s.notify(notes)
	return s.GetInstance(ctx, pluginID, kindName, id)
}

// DeleteInstance removes an instance, its targets, its secrets, and its
// references. It works whether or not the plugin is installed, so leftover
// data can always be cleaned up.
func (s *Service) DeleteInstance(ctx context.Context, pluginID, kindName string, id, userID uuid.UUID) error {
	hosted, kind, err := s.v3Kind(pluginID, kindName)
	if err != nil {
		return err
	}
	notes, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		stored, err := scanInstance(tx.QueryRow(ctx, `SELECT `+instanceColumns+` FROM plugin_instances WHERE id=$1 AND plugin_id=$2 AND kind=$3 FOR UPDATE`, id, pluginID, kindName))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if stored.targetIDs, err = readTargets(ctx, tx, id); err != nil {
			return nil, err
		}
		var storedTarget *plugin.Target
		if stored.targetScope != nil {
			target := stored.target()
			storedTarget = &target
			if err := s.authorizeTarget(ctx, tx, target); err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_instances WHERE id=$1`, id); err != nil {
			return nil, err
		}
		if err := (fontService{pluginID: pluginID}).ReleaseInTx(ctx, tx, id); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM plugin_media_references WHERE plugin_id=$1 AND owner_id=$2`, pluginID, id); err != nil {
			return nil, err
		}
		if err := s.auditInstance(ctx, tx, "plugin.instance.deleted", hosted, kind, id, stored.name, userID, nil, preparedInstance{}); err != nil {
			return nil, err
		}
		return s.invalidateInstance(ctx, tx, hosted, kind, storedTarget, nil, "plugin.instance.deleted")
	})
	if err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

func (s *Service) inTx(ctx context.Context, work func(pgx.Tx) ([]note, error)) ([]note, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	notes, err := work(tx)
	if err != nil {
		return nil, err
	}
	return notes, tx.Commit(ctx)
}

func (s *Service) insertInstance(ctx context.Context, tx pgx.Tx, organizationID uuid.UUID, pluginID string, kind plugin.InstanceKind, id, userID uuid.UUID, prepared preparedInstance) error {
	schedule, next := scheduleColumns(prepared.schedule, s.clock.Now())
	configuration, err := json.Marshal(prepared.configuration)
	if err != nil {
		return err
	}
	var scope *string
	if prepared.target != nil {
		scope = &prepared.target.Scope
	}
	personal := personalWrites(kind.Fields, nil, prepared.configuration, s.clock.Now())
	if _, err := tx.Exec(ctx, `INSERT INTO plugin_instances(id,organization_id,plugin_id,kind,name,enabled,priority,target_scope,schedule,next_schedule_change_at,configuration,personal_written_at,created_by,updated_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
		id, organizationID, pluginID, kind.Kind, prepared.name, prepared.enabled, prepared.priority, scope, schedule, next, configuration, personal, nullableUser(userID)); err != nil {
		return err
	}
	return insertTargets(ctx, tx, id, prepared.target)
}

func insertTargets(ctx context.Context, tx pgx.Tx, id uuid.UUID, target *plugin.Target) error {
	if target == nil || target.Scope == plugin.TargetAll {
		return nil
	}
	for _, targetID := range target.IDs {
		if _, err := tx.Exec(ctx, `INSERT INTO plugin_instance_targets(instance_id,target_type,target_id) VALUES($1,$2,$3)`, id, target.Scope, targetID); err != nil {
			return err
		}
	}
	return nil
}

func scheduleColumns(schedule *plugin.InstanceSchedule, now time.Time) ([]byte, *time.Time) {
	if schedule == nil {
		return nil, nil
	}
	encoded, _ := json.Marshal(schedule)
	return encoded, nextScheduleChange(schedule, now)
}

// checkNewTarget validates a requested target against the organization's
// screens, groups, and locations, and authorizes it for the operator.
func (s *Service) checkNewTarget(ctx context.Context, tx pgx.Tx, target *plugin.Target) error {
	if target == nil {
		return nil
	}
	if err := (targetService{db: s.db}).ValidateInTx(ctx, tx, *target); err != nil {
		return err
	}
	return s.authorizeTarget(ctx, tx, *target)
}

// authorizeTarget decides a target for the Studio operator of ctx with the
// rule every stored core target uses. Work without an operator acts for the
// installation.
func (s *Service) authorizeTarget(ctx context.Context, tx pgx.Tx, target plugin.Target) error {
	principal, ok := plugin.PrincipalFrom(ctx)
	if !ok {
		return nil
	}
	return screenAccessService{}.AuthorizeTargetInTx(ctx, tx, principal, target)
}

// storeInstanceResources records the library fonts and media an instance
// names, and writes or clears its secrets.
func (s *Service) storeInstanceResources(ctx context.Context, tx pgx.Tx, hosted hostedPlugin, kind plugin.InstanceKind, id, userID uuid.UUID, prepared preparedInstance) error {
	pluginID := hosted.manifest.ID
	// The library refuses to remove a family while an instance uses it.
	// Disabled instances count: enabling one must not find the font gone.
	if err := storeConfigReferences(ctx, tx, pluginID, id, prepared.name, kind.Fields, prepared.configuration); err != nil {
		return err
	}
	if err := useConnections(ctx, tx, pluginID, "instance", id, prepared.name, kind.Fields, prepared.configuration); err != nil {
		return err
	}
	ref := func(key string) pluginsecrets.SecretRef {
		return pluginsecrets.SecretRef{PluginID: pluginID, OwnerType: pluginsecrets.OwnerInstance, OwnerID: id, Key: key}
	}
	for key, value := range prepared.secrets {
		if err := s.secrets.WriteInTx(ctx, tx, ref(key), value, nullableUser(userID)); err != nil {
			return err
		}
	}
	for _, key := range prepared.clear {
		if _, err := s.secrets.DeleteInTx(ctx, tx, ref(key)); err != nil {
			return err
		}
	}
	return nil
}

func storeConfigReferences(ctx context.Context, tx pgx.Tx, pluginID string, id uuid.UUID, label string, fields []configschema.Field, values map[string]any) error {
	fontIDs := []uuid.UUID{}
	for _, value := range configschema.FontValues(fields, values) {
		fontIDs = append(fontIDs, uuid.MustParse(value))
	}
	if err := (fontService{pluginID: pluginID}).UseInTx(ctx, tx, id, label, fontIDs...); err != nil {
		return err
	}
	return useMedia(ctx, tx, pluginID, id, label, configschema.MediaAssetValues(fields, values))
}

// useMedia replaces the library media one owner names. Each asset is locked
// FOR SHARE so a concurrent archive waits for this transaction.
func useMedia(ctx context.Context, tx pgx.Tx, pluginID string, ownerID uuid.UUID, label string, assetIDs []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM plugin_media_references WHERE plugin_id=$1 AND owner_id=$2`, pluginID, ownerID); err != nil {
		return err
	}
	label = truncateLabel(label)
	for _, value := range assetIDs {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1 AND deleted_at IS NULL FOR SHARE)`, value).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return plugin.Invalidf("a selected media item is no longer in the library")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO plugin_media_references(plugin_id,owner_id,asset_id,label) VALUES($1,$2,$3,$4)
			ON CONFLICT (plugin_id,owner_id,asset_id) DO UPDATE SET label=EXCLUDED.label`, pluginID, ownerID, value, label); err != nil {
			return err
		}
	}
	return nil
}

func truncateLabel(label string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		label = "Plugin setting"
	}
	if runes := []rune(label); len(runes) > maxFontLabelRunes {
		label = string(runes[:maxFontLabelRunes])
	}
	return label
}

// auditInstance records an instance change. It names the changed keys and
// the secret keys written or cleared, never a value.
func (s *Service) auditInstance(ctx context.Context, tx pgx.Tx, action string, hosted hostedPlugin, kind plugin.InstanceKind, id uuid.UUID, name string, userID uuid.UUID, changed []string, prepared preparedInstance) error {
	metadata := map[string]any{"pluginId": hosted.manifest.ID, "kind": kind.Kind}
	if changed != nil {
		metadata["changedKeys"] = changed
	}
	if len(prepared.secrets) > 0 || len(prepared.clear) > 0 {
		keys := []string{}
		for key := range prepared.secrets {
			keys = append(keys, key)
		}
		keys = append(keys, prepared.clear...)
		sortStrings(keys)
		metadata["secretKeys"] = keys
	}
	record := audit.Event{Action: action, ResourceType: "plugin_instance", ResourceID: id.String(), ResourceName: name, Metadata: metadata}
	if userID != uuid.Nil {
		actor := userID
		record.Actor = &actor
	}
	if audit.SurfaceFrom(ctx) == "" {
		record.Surface = audit.SurfaceSystem
		record.ClientID = "tilecast-server"
	}
	return audit.RecordTx(ctx, tx, record)
}

func sameTarget(left, right *plugin.Target) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	if left.Scope != right.Scope || len(left.IDs) != len(right.IDs) {
		return false
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range left.IDs {
		seen[id] = true
	}
	for _, id := range right.IDs {
		if !seen[id] {
			return false
		}
	}
	return true
}

func sameSchedule(left, right *plugin.InstanceSchedule) bool {
	a, _ := json.Marshal(left)
	b, _ := json.Marshal(right)
	return string(a) == string(b)
}

// personalWrites returns the personal field keys whose values this write
// sets or changes, with the write time, as a JSON object to merge.
func personalWrites(fields []configschema.Field, before, after map[string]any, now time.Time) []byte {
	stamps := map[string]string{}
	for _, field := range fields {
		if field.Personal == nil {
			continue
		}
		left, _ := json.Marshal(before[field.Key])
		right, _ := json.Marshal(after[field.Key])
		if _, present := after[field.Key]; present && string(left) != string(right) {
			stamps[field.Key] = now.UTC().Format(time.RFC3339)
		}
	}
	encoded, _ := json.Marshal(stamps)
	return encoded
}
