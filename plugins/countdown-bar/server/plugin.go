// Package server is Countdown Bar's server contribution: storage, validation,
// status, removal blockers, dashboard routes, and the Player manifest
// projection.
package server

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ManifestType is the Player manifest entry type, version 1.
const ManifestType = "countdown_bar"

// Plugin is Countdown Bar.
type Plugin struct {
	plugin.Bundle
	host plugin.Host
}

var (
	_ plugin.Initializer       = (*Plugin)(nil)
	_ plugin.StatusReporter    = (*Plugin)(nil)
	_ plugin.RemovalGuard      = (*Plugin)(nil)
	_ plugin.RouteProvider     = (*Plugin)(nil)
	_ plugin.ManifestProjector = (*Plugin)(nil)
)

func New(bundle plugin.Bundle) *Plugin {
	return &Plugin{Bundle: bundle}
}

func (p *Plugin) Init(_ context.Context, host plugin.Host) error {
	p.host = host
	return nil
}

// Status: configured once any instance exists, active while any is enabled.
func (p *Plugin) Status(ctx context.Context) (plugin.Status, error) {
	var status plugin.Status
	err := p.host.DB.QueryRow(ctx, `SELECT COALESCE(bool_or(enabled),FALSE),count(*) FROM countdown_bar_instances`).
		Scan(&status.Active, &status.InstanceCount)
	status.Configured = status.InstanceCount > 0
	return status, err
}

// RemovalBlockers: every instance, enabled or not, blocks removal.
func (p *Plugin) RemovalBlockers(ctx context.Context, tx pgx.Tx) ([]plugin.Blocker, error) {
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM countdown_bar_instances`).Scan(&count); err != nil {
		return nil, err
	}
	return []plugin.Blocker{{Kind: "countdown_bar_instance", Count: count,
		Singular: "countdown bar", Plural: "countdown bars", Resolution: plugin.ResolveDelete}}, nil
}

// ProjectManifest publishes every enabled instance that applies to the screen.
// Players choose which one shows from the priorities in the entries.
func (p *Plugin) ProjectManifest(ctx context.Context, screenID uuid.UUID) ([]plugin.ManifestEntry, error) {
	rows, err := p.host.DB.Query(ctx, `SELECT DISTINCT i.id,i.name,i.message,i.schedule_type,i.target_time::text,i.days_of_week,
		i.one_time_at,i.timezone,i.lead_time_seconds,i.completion_text,i.show_confetti,i.display_mode,i.height_px,i.progress_fill,i.content_padding,i.text_scale,
		i.urgency_enabled,i.starting_soon_seconds,i.urgent_seconds,i.pulse_seconds,i.priority
		`+plugin.ScreenTargetFilter("countdown_bar_instances", "countdown_bar_targets")+`
		ORDER BY i.priority DESC,i.id`, screenID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []plugin.ManifestEntry{}
	for rows.Next() {
		var id uuid.UUID
		var config ManifestConfig
		if err = rows.Scan(&id, &config.Name, &config.Message, &config.ScheduleType, &config.TargetTime,
			&config.DaysOfWeek, &config.OneTimeAt, &config.Timezone, &config.LeadTimeSeconds,
			&config.CompletionText, &config.ShowConfetti, &config.DisplayMode, &config.HeightPX, &config.ProgressFill, &config.ContentPadding, &config.TextScale,
			&config.UrgencyEnabled, &config.StartingSoonSeconds, &config.UrgentSeconds, &config.PulseSeconds, &config.Priority); err != nil {
			return nil, err
		}
		config.TargetTime = trimTargetTime(config.TargetTime)
		out = append(out, plugin.ManifestEntry{ID: id, Type: ManifestType, Version: 1, Config: config})
	}
	return out, rows.Err()
}
