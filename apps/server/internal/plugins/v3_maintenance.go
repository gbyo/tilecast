package plugins

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Host maintenance for Plugin Manifest API 3 storage: schedule boundaries
// and personal-data retention.

const (
	scheduleTick  = 30 * time.Second
	retentionTick = 6 * time.Hour
)

// RunMaintenance runs the host's API 3 loops until ctx ends.
func (s *Service) RunMaintenance(ctx context.Context) {
	schedule := time.NewTicker(scheduleTick)
	retention := time.NewTicker(retentionTick)
	defer schedule.Stop()
	defer retention.Stop()
	s.maintain(ctx, true)
	for {
		select {
		case <-ctx.Done():
			return
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
			count, err := s.purgeTable(ctx, now, manifest.ID, "plugin_instances", "configuration", `kind=$2`, kind.Kind, kind.Fields)
			if err != nil {
				return removed, err
			}
			removed += count
		}
		if manifest.Settings != nil {
			for scope, fields := range map[string][]configschema.Field{scopeOrganization: manifest.Settings.Organization, scopeScreen: manifest.Settings.Screen} {
				count, err := s.purgeTable(ctx, now, manifest.ID, "plugin_settings", `"values"`, `scope=$2`, scope, fields)
				if err != nil {
					return removed, err
				}
				removed += count
			}
		}
	}
	return removed, nil
}

// purgeTable removes expired personal values from one table. Table and
// column names are literals from this file.
func (s *Service) purgeTable(ctx context.Context, now time.Time, pluginID, table, column, filter, filterValue string, fields []configschema.Field) (int, error) {
	removed := 0
	for _, field := range fields {
		if field.Personal == nil {
			continue
		}
		cutoff := now.Add(-time.Duration(field.Personal.RetentionDays) * 24 * time.Hour).UTC().Format(time.RFC3339)
		if field.Control == configschema.ControlSecret {
			owner := "owner_type<>'instance'"
			if table == "plugin_instances" {
				owner = "owner_type='instance'"
			}
			tag, err := s.db.Exec(ctx, `DELETE FROM plugin_secrets WHERE plugin_id=$1 AND setting_key=$2 AND `+owner+` AND updated_at<$3`, pluginID, field.Key, cutoff)
			if err != nil {
				return removed, err
			}
			removed += int(tag.RowsAffected())
			continue
		}
		tag, err := s.db.Exec(ctx, `UPDATE `+table+` SET `+column+`=`+column+`-$3::text, personal_written_at=personal_written_at-$3::text
			WHERE plugin_id=$1 AND `+filter+` AND personal_written_at ? $3 AND (personal_written_at->>$3)<$4`,
			pluginID, filterValue, field.Key, cutoff)
		if err != nil {
			return removed, err
		}
		removed += int(tag.RowsAffected())
	}
	return removed, nil
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
