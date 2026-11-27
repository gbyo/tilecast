package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Host maintenance for Plugin Manifest API 3 storage: schedule boundaries,
// the delivery loop, feed images, expired OAuth attempts, and personal-data
// retention.

const (
	scheduleTick  = 30 * time.Second
	retentionTick = 6 * time.Hour
	imageTick     = 5 * time.Second
)

// RunMaintenance runs the host's API 3 loops until ctx ends.
func (s *Service) RunMaintenance(ctx context.Context) {
	schedule := time.NewTicker(scheduleTick)
	retention := time.NewTicker(retentionTick)
	images := time.NewTicker(imageTick)
	defer schedule.Stop()
	defer retention.Stop()
	defer images.Stop()
	go s.RunDeliveryLoop(ctx)
	s.maintain(ctx, true)
	for {
		select {
		case <-ctx.Done():
			return
		case <-images.C:
			if s.backgroundJobs != nil && !s.backgroundJobs.Allowed() {
				continue
			}
			if _, err := s.RunFeedImageImports(ctx); err != nil && ctx.Err() == nil {
				s.logger.Warn("plugin feed image pass failed", "error", err)
			}
		case <-schedule.C:
			s.maintain(ctx, false)
		case <-retention.C:
			s.maintain(ctx, true)
		}
	}
}

func (s *Service) maintain(ctx context.Context, retention bool) {
	if s.backgroundJobs != nil && !s.backgroundJobs.Allowed() {
		return
	}
	if _, err := s.AdvanceSchedules(ctx); err != nil && ctx.Err() == nil {
		s.logger.Warn("plugin instance schedule pass failed", "error", err)
	}
	if _, err := s.ExpireOAuthAttempts(ctx); err != nil && ctx.Err() == nil {
		s.logger.Warn("plugin oauth attempt sweep failed", "error", err)
	}
	if _, err := s.CollectFeedAssets(ctx); err != nil && ctx.Err() == nil {
		s.logger.Warn("plugin feed image collection failed", "error", err)
	}
	if retention {
		if _, err := s.PurgePersonalData(ctx); err != nil && ctx.Err() == nil {
			s.logger.Warn("plugin personal data retention pass failed", "error", err)
		}
	}
}

// AdvanceSchedules invalidates the screens of every instance whose host
// schedule starts or ends a projection now, and records its next change.
func (s *Service) AdvanceSchedules(ctx context.Context) (int, error) {
	now := s.clock.Now()
	advanced := 0
	for {
		notes, done, err := s.advanceOne(ctx, now)
		if err != nil {
			return advanced, err
		}
		if done {
			return advanced, nil
		}
		advanced++
		s.notify(notes)
	}
}

func (s *Service) advanceOne(ctx context.Context, now time.Time) ([]note, bool, error) {
	var notes []note
	done := false
	_, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		row, err := scanInstance(tx.QueryRow(ctx, `SELECT `+instanceColumns+` FROM plugin_instances
			WHERE next_schedule_change_at<=$1 ORDER BY next_schedule_change_at LIMIT 1 FOR UPDATE SKIP LOCKED`, now))
		if errors.Is(err, pgx.ErrNoRows) {
			done = true
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		pluginID := ""
		if err := tx.QueryRow(ctx, `SELECT plugin_id FROM plugin_instances WHERE id=$1`, row.id).Scan(&pluginID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE plugin_instances SET next_schedule_change_at=$2 WHERE id=$1`, row.id, nextScheduleChange(row.schedule, now)); err != nil {
			return nil, err
		}
		hosted, ok := s.hostedPlugin(pluginID)
		if !ok || !row.enabled || row.targetScope == nil {
			return nil, nil
		}
		kind, ok := hosted.manifest.InstanceKindByName(row.kind)
		if !ok {
			return nil, nil
		}
		if row.targetIDs, err = readTargets(ctx, tx, row.id); err != nil {
			return nil, err
		}
		target := row.target()
		notes, err = s.invalidateInstance(ctx, tx, hosted, kind, &target, nil, "plugin.instance.schedule")
		return nil, err
	})
	return notes, done, err
}

// PurgePersonalData removes personal field values, and personal secrets,
// whose declared retention has ended since their last write. A personal
// field is never required, so removing its value leaves a valid document.
func (s *Service) PurgePersonalData(ctx context.Context) (int, error) {
	now := s.clock.Now()
	removed := 0
	for _, hosted := range s.hosted {
		manifest := hosted.manifest
		if manifest.APIVersion < 3 {
			continue
		}
		for _, kind := range manifest.Instances {
			count, err := s.purgePersonalFields(ctx, now, hosted, kind.Fields, retentionOwner{
				table: "plugin_instances", values: "configuration", filter: "kind", selector: kind.Kind,
				ownerType: pluginsecrets.OwnerInstance, ownerID: "d.id",
			}, func(tx pgx.Tx, id uuid.UUID) ([]note, error) {
				return s.refreshPurgedInstance(ctx, tx, hosted, kind, id)
			})
			if err != nil {
				return removed, err
			}
			removed += count
		}
		if manifest.Settings != nil {
			for _, scope := range []string{scopeOrganization, scopeScreen} {
				fields, ownerType, ownerID := manifest.Settings.Organization, pluginsecrets.OwnerOrganization, "d.organization_id"
				if scope == scopeScreen {
					fields, ownerType, ownerID = manifest.Settings.Screen, pluginsecrets.OwnerScreen, "d.screen_id"
				}
				count, err := s.purgePersonalFields(ctx, now, hosted, fields, retentionOwner{
					table: "plugin_settings", values: `"values"`, filter: "scope", selector: scope,
					ownerType: ownerType, ownerID: ownerID,
				}, func(tx pgx.Tx, id uuid.UUID) ([]note, error) {
					return s.refreshPurgedSettings(ctx, tx, hosted, fields, scope, id)
				})
				if err != nil {
					return removed, err
				}
				removed += count
			}
		}
	}
	count, err := s.purgeFeedPersonalData(ctx, now)
	return removed + count, err
}

// SQL identifiers and expressions are literals chosen by PurgePersonalData.
type retentionOwner struct {
	table, values, filter, selector, ownerType, ownerID string
}

func (s *Service) purgePersonalFields(ctx context.Context, now time.Time, hosted hostedPlugin, fields []configschema.Field, owner retentionOwner, refresh func(pgx.Tx, uuid.UUID) ([]note, error)) (int, error) {
	if !slices.ContainsFunc(fields, func(field configschema.Field) bool { return field.Personal != nil }) {
		return 0, nil
	}
	removed := 0
	notes, err := s.inTx(ctx, func(tx pgx.Tx) ([]note, error) {
		changed := map[uuid.UUID]struct{}{}
		for _, field := range fields {
			if field.Personal == nil {
				continue
			}
			cutoff := now.Add(-time.Duration(field.Personal.RetentionDays) * 24 * time.Hour).UTC().Truncate(time.Second)
			ids, err := owner.purge(ctx, tx, hosted.manifest.ID, field, cutoff)
			if err != nil {
				return nil, err
			}
			removed += len(ids)
			for _, id := range ids {
				changed[id] = struct{}{}
			}
		}
		var notes []note
		for id := range changed {
			if _, err := tx.Exec(ctx, `UPDATE `+owner.table+` SET revision=revision+1,updated_at=now() WHERE id=$1`, id); err != nil {
				return nil, err
			}
			updated, err := refresh(tx, id)
			if err != nil {
				return nil, err
			}
			notes = append(notes, updated...)
		}
		return notes, nil
	})
	if err != nil {
		return 0, err
	}
	s.notify(notes)
	return removed, nil
}

func (owner retentionOwner) purge(ctx context.Context, tx pgx.Tx, pluginID string, field configschema.Field, cutoff time.Time) ([]uuid.UUID, error) {
	query := `UPDATE ` + owner.table + ` SET ` + owner.values + `=` + owner.values + `-$3::text, personal_written_at=personal_written_at-$3::text
		WHERE plugin_id=$1 AND ` + owner.filter + `=$2 AND ` + owner.values + ` ? $3 AND (personal_written_at->>$3)<$4
		RETURNING id`
	args := []any{pluginID, owner.selector, field.Key, cutoff.Format(time.RFC3339)}
	if field.Control == configschema.ControlSecret {
		// Lock the owning document before deleting its secret, in the same
		// order as interactive writes. Recheck the deadline after any wait.
		query = `WITH owners AS MATERIALIZED (
			SELECT d.id, ` + owner.ownerID + ` AS owner_id FROM ` + owner.table + ` d
			JOIN plugin_secrets s ON s.plugin_id=d.plugin_id AND s.owner_id=` + owner.ownerID + `
			WHERE d.plugin_id=$1 AND d.` + owner.filter + `=$2 AND s.setting_key=$3 AND s.updated_at<$4 AND s.owner_type=$5
			FOR UPDATE OF d
		)
		DELETE FROM plugin_secrets s USING owners o
		WHERE s.plugin_id=$1 AND s.owner_id=o.owner_id AND s.setting_key=$3 AND s.updated_at<$4 AND s.owner_type=$5
		RETURNING o.id`
		args = []any{pluginID, owner.selector, field.Key, cutoff, owner.ownerType}
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

func (s *Service) refreshPurgedInstance(ctx context.Context, tx pgx.Tx, hosted hostedPlugin, kind plugin.InstanceKind, id uuid.UUID) ([]note, error) {
	row, err := scanInstance(tx.QueryRow(ctx, `SELECT `+instanceColumns+` FROM plugin_instances WHERE id=$1`, id))
	if err != nil {
		return nil, err
	}
	if err := storeConfigReferences(ctx, tx, hosted.manifest.ID, id, row.name, kind.Fields, row.configuration); err != nil {
		return nil, err
	}
	if !row.enabled || row.targetScope == nil {
		return nil, nil
	}
	if row.targetIDs, err = readTargets(ctx, tx, id); err != nil {
		return nil, err
	}
	target := row.target()
	return s.invalidateInstance(ctx, tx, hosted, kind, &target, nil, "plugin.instance.retention")
}

func (s *Service) refreshPurgedSettings(ctx context.Context, tx pgx.Tx, hosted hostedPlugin, fields []configschema.Field, scope string, id uuid.UUID) ([]note, error) {
	var raw []byte
	var screenID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT "values",screen_id FROM plugin_settings WHERE id=$1`, id).Scan(&raw, &screenID); err != nil {
		return nil, err
	}
	var values map[string]any
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, err
	}
	if err := storeConfigReferences(ctx, tx, hosted.manifest.ID, id, hosted.definition.Name+" settings", fields, values); err != nil {
		return nil, err
	}
	if screenID != nil {
		return s.invalidateSettings(ctx, tx, hosted, scope, *screenID)
	}
	return s.invalidateSettings(ctx, tx, hosted, scope, uuid.Nil)
}

// seedDemoInstances installs the plugin and creates its Demo Mode
// instances through the host's instance service.
func (s *Service) seedDemoInstances(ctx context.Context, hosted hostedPlugin, seeder plugin.InstanceDemoSeeder, demo plugin.Demo) error {
	if _, _, err := s.Install(ctx, hosted.manifest.ID, demo.OwnerID); err != nil {
		return fmt.Errorf("install plugin %s: %w", hosted.manifest.ID, err)
	}
	seedCtx, done := s.backgroundInvocation(ctx, hosted.manifest.ID)
	defer done()
	instances, err := seeder.DemoInstances(seedCtx, demo)
	if err != nil {
		return fmt.Errorf("plugin %s: demo instances: %w", hosted.manifest.ID, err)
	}
	for _, instance := range instances {
		name, enabled, priority := instance.Name, instance.Enabled, instance.Priority
		write := instanceWrite{Name: &name, Enabled: &enabled, Target: instance.Target, Schedule: instance.Schedule, Configuration: instance.Configuration}
		if kind, ok := hosted.manifest.InstanceKindByName(instance.Kind); ok && kind.Priority != nil {
			write.Priority = &priority
		}
		if _, err := s.CreateInstance(ctx, hosted.manifest.ID, instance.Kind, demo.OwnerID, write); err != nil {
			return fmt.Errorf("plugin %s: demo instance %q: %w", hosted.manifest.ID, instance.Name, err)
		}
	}
	return nil
}
