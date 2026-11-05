// Package server is Countdown Bar's server contribution: storage, validation,
// status, removal blockers, dashboard routes, the Plugin API 2 Player state
// projection with its Plugin API 1 compatibility entries, and the operator
// automation mapping.
package server

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// ManifestType is the Player manifest entry type, version 1. It is also the
// Plugin API 2 Player state type, version 1, with the same configuration.
const ManifestType = "countdown_bar"

// Plugin is Countdown Bar.
type Plugin struct {
	plugin.Bundle
	host       plugin.Host
	automation []byte
}

var (
	_ plugin.Initializer          = (*Plugin)(nil)
	_ plugin.StatusReporter       = (*Plugin)(nil)
	_ plugin.RemovalGuard         = (*Plugin)(nil)
	_ plugin.RouteProvider        = (*Plugin)(nil)
	_ plugin.ManifestProjector    = (*Plugin)(nil)
	_ plugin.PlayerStateProjector = (*Plugin)(nil)
	_ plugin.AutomationProvider   = (*Plugin)(nil)
)

// Automation returns the resolved automation document the plugin package
// embeds. It is data, not code: the host serves it to operator clients,
// which dispatch on it without naming this plugin in their own source.
func (p *Plugin) Automation() []byte { return p.automation }

func New(bundle plugin.Bundle, automation []byte) *Plugin {
	return &Plugin{Bundle: bundle, automation: automation}
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

// ProjectPlayerState publishes every enabled instance that applies to the
// screen as Plugin API 2 Player state. Players choose which one shows from
// the priorities in the state.
func (p *Plugin) ProjectPlayerState(ctx context.Context, screenID uuid.UUID) ([]plugin.PlayerState, error) {
	instances, err := p.screenInstances(ctx, screenID)
	if err != nil {
		return nil, err
	}
	out := make([]plugin.PlayerState, 0, len(instances))
	for _, instance := range instances {
		out = append(out, plugin.PlayerState{ID: instance.id, Type: ManifestType, Version: 1, State: instance.config})
	}
	return out, nil
}

// ProjectManifest publishes the same instances as Plugin API 1 entries for a
// Player that does not host Plugin API 2 (player.v1ManifestTypes).
func (p *Plugin) ProjectManifest(ctx context.Context, screenID uuid.UUID) ([]plugin.ManifestEntry, error) {
	instances, err := p.screenInstances(ctx, screenID)
	if err != nil {
		return nil, err
	}
	out := make([]plugin.ManifestEntry, 0, len(instances))
	for _, instance := range instances {
		out = append(out, plugin.ManifestEntry{ID: instance.id, Type: ManifestType, Version: 1, Config: instance.config})
	}
	return out, nil
}

type screenInstance struct {
	id     uuid.UUID
	config ManifestConfig
}

// screenInstances reads every enabled instance that applies to the screen,
// strongest priority first.
func (p *Plugin) screenInstances(ctx context.Context, screenID uuid.UUID) ([]screenInstance, error) {
	rows, err := p.host.DB.Query(ctx, `SELECT DISTINCT i.id,i.name,i.message,i.schedule_type,i.target_time::text,i.days_of_week,
		i.one_time_at,i.timezone,i.lead_time_seconds,i.completion_text,i.show_confetti,i.display_mode,i.height_px,i.progress_fill,i.content_padding,i.text_scale,
		i.urgency_enabled,i.starting_soon_seconds,i.urgent_seconds,i.pulse_seconds,i.priority
		`+plugin.ScreenTargetFilter("countdown_bar_instances", "countdown_bar_targets")+`
		ORDER BY i.priority DESC,i.id`, screenID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []screenInstance{}
	for rows.Next() {
		var instance screenInstance
		config := &instance.config
		if err = rows.Scan(&instance.id, &config.Name, &config.Message, &config.ScheduleType, &config.TargetTime,
			&config.DaysOfWeek, &config.OneTimeAt, &config.Timezone, &config.LeadTimeSeconds,
			&config.CompletionText, &config.ShowConfetti, &config.DisplayMode, &config.HeightPX, &config.ProgressFill, &config.ContentPadding, &config.TextScale,
			&config.UrgencyEnabled, &config.StartingSoonSeconds, &config.UrgentSeconds, &config.PulseSeconds, &config.Priority); err != nil {
			return nil, err
		}
		config.TargetTime = trimTargetTime(config.TargetTime)
		out = append(out, instance)
	}
	return out, rows.Err()
}
