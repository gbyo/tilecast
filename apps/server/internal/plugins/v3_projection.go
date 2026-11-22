package plugins

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/targeting"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Projection, invalidation, status, and removal for host-owned instances.

func sortStrings(values []string) { sort.Strings(values) }

// configReferences checks font and media identifiers in plugin
// configuration against the library. The save transaction locks each
// referenced row again before it records the reference.
func (s *Service) configReferences() configschema.References { return pluginReferences{db: s.db} }

type pluginReferences struct{ db queryer }

func (pluginReferences) DataSource(context.Context, configschema.Field, uuid.UUID) error {
	return fmt.Errorf("Data Source fields are not available to plugins")
}

func (r pluginReferences) MediaAsset(ctx context.Context, field configschema.Field, id uuid.UUID) error {
	var assetType string
	if err := r.db.QueryRow(ctx, `SELECT type FROM assets WHERE id=$1 AND deleted_at IS NULL AND processing_status='ready'`, id).Scan(&assetType); err != nil {
		return fmt.Errorf("%s references an unavailable media asset", field.Label)
	}
	if len(field.MediaTypes) > 0 {
		allowed := false
		for _, value := range field.MediaTypes {
			allowed = allowed || value == assetType
		}
		if !allowed {
			return fmt.Errorf("%s references an incompatible media asset", field.Label)
		}
	}
	return nil
}

func (r pluginReferences) Font(ctx context.Context, field configschema.Field, id uuid.UUID) error {
	var exists bool
	if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM font_families WHERE id=$1 AND deleted_at IS NULL)`, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%s references a font that is not in the font library", field.Label)
	}
	return nil
}

// invalidateInstance bumps the manifests of the screens an instance reached
// before the change and the ones it reaches after it. A plugin without a
// Player contribution, and a kind without screen targets, change no
// manifest.
func (s *Service) invalidateInstance(ctx context.Context, tx pgx.Tx, hosted hostedPlugin, kind plugin.InstanceKind, before, after *plugin.Target, reason string) ([]note, error) {
	if !hosted.manifest.PlayerFacing() || kind.Targeting != plugin.TargetingScreens {
		return nil, nil
	}
	targets := []plugin.Target{}
	for _, target := range []*plugin.Target{before, after} {
		if target != nil {
			targets = append(targets, *target)
		}
	}
	screens, all, err := resolveTargetScreens(ctx, tx, targets)
	if err != nil {
		return nil, err
	}
	reason = reason + ":" + hosted.manifest.ID
	if all {
		return bumpAllScreens(ctx, tx, reason)
	}
	return bumpScreens(ctx, tx, screens, reason)
}

// resolveTargetScreens resolves targets to live screen IDs. all is true when
// a target names every screen.
func resolveTargetScreens(ctx context.Context, tx pgx.Tx, targets []plugin.Target) ([]uuid.UUID, bool, error) {
	definition := targeting.Definition{Mode: "selected"}
	for _, target := range targets {
		switch target.Scope {
		case plugin.TargetAll:
			return nil, true, nil
		case plugin.TargetScreens:
			definition.ScreenIDs = append(definition.ScreenIDs, target.IDs...)
		case plugin.TargetSyncGroups:
			definition.GroupIDs = append(definition.GroupIDs, target.IDs...)
		case plugin.TargetLocations:
			rows, err := tx.Query(ctx, `SELECT id FROM screens WHERE location_id=ANY($1) AND archived_at IS NULL`, target.IDs)
			if err != nil {
				return nil, false, err
			}
			ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
			if err != nil {
				return nil, false, err
			}
			definition.ScreenIDs = append(definition.ScreenIDs, ids...)
		}
	}
	if len(definition.ScreenIDs) == 0 && len(definition.GroupIDs) == 0 {
		return []uuid.UUID{}, false, nil
	}
	screens, err := targeting.Resolve(ctx, tx, definition)
	return screens, false, err
}

// eligibleInstance is one instance the host projects to a screen.
type eligibleInstance struct {
	row        instanceRow
	kind       plugin.InstanceKind
	validUntil time.Time
}

// eligibleInstances reads the enabled, targeted, scheduled instances of
// every screen-targeting kind for one screen, strongest priority first.
func (s *Service) eligibleInstances(ctx context.Context, hosted hostedPlugin, screenID uuid.UUID) ([]eligibleInstance, error) {
	now := s.clock.Now()
	out := []eligibleInstance{}
	for _, kind := range hosted.manifest.Instances {
		if kind.Targeting != plugin.TargetingScreens {
			continue
		}
		rows, err := s.db.Query(ctx, `SELECT i.id,i.kind,i.name,i.enabled,i.priority,i.target_scope,i.schedule,i.configuration,i.revision,i.created_at,i.updated_at
			`+plugin.ScreenTargetFilter("plugin_instances", "plugin_instance_targets")+`
			AND i.plugin_id=$2 AND i.kind=$3 ORDER BY i.priority DESC,i.id`, screenID, hosted.manifest.ID, kind.Kind)
		if err != nil {
			return nil, err
		}
		items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (instanceRow, error) { return scanInstance(row) })
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			active, until := scheduleActive(item.schedule, now)
			if !active {
				continue
			}
			out = append(out, eligibleInstance{row: item, kind: kind, validUntil: until})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].row.priority != out[j].row.priority {
			return out[i].row.priority > out[j].row.priority
		}
		return out[i].row.id.String() < out[j].row.id.String()
	})
	return out, nil
}

// projectInstances asks the plugin to project each eligible instance.
func (s *Service) projectInstances(ctx context.Context, hosted hostedPlugin, screenID uuid.UUID) ([]plugin.InstanceProjection, []eligibleInstance, error) {
	projector, ok := hosted.plugin.(plugin.InstanceProjector)
	if !ok {
		return nil, nil, nil
	}
	instances, err := s.eligibleInstances(ctx, hosted, screenID)
	if err != nil || len(instances) == 0 {
		return nil, nil, err
	}
	organization, screen, err := s.projectionSettings(ctx, hosted, screenID)
	if err != nil {
		return nil, nil, err
	}
	target := plugin.ProjectionTarget{ScreenID: screenID, OrganizationSettings: organization, ScreenSettings: screen}
	invocationCtx, done := s.systemInvocation(ctx, hosted.manifest.ID)
	defer done()
	out := make([]plugin.InstanceProjection, 0, len(instances))
	for index := range instances {
		instance := &instances[index]
		if instance.row.targetIDs, err = readTargets(ctx, s.db, instance.row.id); err != nil {
			return nil, nil, err
		}
		projection, err := projector.ProjectInstance(invocationCtx, instance.row.hosted(instance.kind), target)
		if err != nil {
			return nil, nil, fmt.Errorf("plugin %s: project instance %s: %w", hosted.manifest.ID, instance.row.id, err)
		}
		out = append(out, projection)
	}
	return out, instances, nil
}

// instancePlayerState projects Plugin API 2 Player state for one screen.
// The host sets each state's ID to its instance, adds the library fonts the
// instance's font fields choose, and limits the state to the end of the
// current schedule period, so an offline Player stops showing it on time.
func (s *Service) instancePlayerState(ctx context.Context, hosted hostedPlugin, screenID uuid.UUID) ([]plugin.PlayerState, error) {
	projections, instances, err := s.projectInstances(ctx, hosted, screenID)
	if err != nil {
		return nil, err
	}
	out := []plugin.PlayerState{}
	for index, projection := range projections {
		if projection.State == nil {
			continue
		}
		instance := instances[index]
		state := *projection.State
		state.ID = instance.row.id
		for _, value := range configschema.FontValues(instance.kind.Fields, instance.row.configuration) {
			id := uuid.MustParse(value)
			known := false
			for _, existing := range state.Fonts {
				known = known || existing == id
			}
			if !known {
				state.Fonts = append(state.Fonts, id)
			}
		}
		if !instance.validUntil.IsZero() && (state.ValidUntil == nil || instance.validUntil.Before(*state.ValidUntil)) {
			until := instance.validUntil
			state.ValidUntil = &until
		}
		out = append(out, state)
	}
	return out, nil
}

// instanceLegacyEntries projects Plugin API 1 entries for a Player without
// the Plugin API 2 host.
func (s *Service) instanceLegacyEntries(ctx context.Context, hosted hostedPlugin, screenID uuid.UUID) ([]plugin.ManifestEntry, error) {
	if hosted.manifest.Player == nil || len(hosted.manifest.Player.V1ManifestTypes) == 0 {
		return nil, nil
	}
	projections, instances, err := s.projectInstances(ctx, hosted, screenID)
	if err != nil {
		return nil, err
	}
	out := []plugin.ManifestEntry{}
	for index, projection := range projections {
		if projection.Legacy == nil {
			continue
		}
		entry := *projection.Legacy
		entry.ID = instances[index].row.id
		out = append(out, entry)
	}
	return out, nil
}

// projectionSettings reads the plugin's non-secret settings for a screen.
func (s *Service) projectionSettings(ctx context.Context, hosted hostedPlugin, screenID uuid.UUID) (map[string]any, map[string]any, error) {
	if hosted.manifest.Settings == nil {
		return map[string]any{}, map[string]any{}, nil
	}
	organization, err := s.settingsValues(ctx, hosted.manifest.ID, scopeOrganization, uuid.Nil)
	if err != nil {
		return nil, nil, err
	}
	screen, err := s.settingsValues(ctx, hosted.manifest.ID, scopeScreen, screenID)
	return organization, screen, err
}

func (s *Service) settingsValues(ctx context.Context, pluginID, scope string, screenID uuid.UUID) (map[string]any, error) {
	var raw []byte
	var err error
	if scope == scopeOrganization {
		err = s.db.QueryRow(ctx, `SELECT "values" FROM plugin_settings WHERE plugin_id=$1 AND scope='organization'`, pluginID).Scan(&raw)
	} else {
		err = s.db.QueryRow(ctx, `SELECT "values" FROM plugin_settings WHERE plugin_id=$1 AND scope='screen' AND screen_id=$2`, pluginID, screenID).Scan(&raw)
	}
	values := map[string]any{}
	if err == pgx.ErrNoRows {
		return values, nil
	}
	if err != nil {
		return nil, err
	}
	return values, json.Unmarshal(raw, &values)
}

// instanceStatus answers the catalog for a plugin whose instances the host
// stores: configured once any instance exists, active while one is enabled.
func (s *Service) instanceStatus(ctx context.Context, pluginID string) (pluginStatus, error) {
	var status pluginStatus
	err := s.db.QueryRow(ctx, `SELECT COALESCE(bool_or(enabled),FALSE),count(*) FROM plugin_instances WHERE plugin_id=$1`, pluginID).
		Scan(&status.active, &status.count)
	status.configured = status.count > 0
	return status, err
}

// instanceBlockers lists each kind's instances as a removal blocker: every
// instance, enabled or not, blocks removal.
func instanceBlockers(ctx context.Context, tx pgx.Tx, manifest plugin.Manifest) ([]plugin.Blocker, error) {
	out := []plugin.Blocker{}
	for _, kind := range manifest.Instances {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM plugin_instances WHERE plugin_id=$1 AND kind=$2`, manifest.ID, kind.Kind).Scan(&count); err != nil {
			return nil, err
		}
		if count > 0 {
			out = append(out, plugin.Blocker{Kind: manifest.ID + "_" + kind.Kind, Count: count, Singular: kind.Noun.Singular,
				Plural: kind.Noun.Plural, Resolution: plugin.ResolveDelete})
		}
	}
	return out, nil
}
