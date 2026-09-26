package server

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

var (
	_ plugin.Initializer       = (*Service)(nil)
	_ plugin.StatusReporter    = (*Service)(nil)
	_ plugin.RemovalGuard      = (*Service)(nil)
	_ plugin.RouteProvider     = (*Service)(nil)
	_ plugin.ManifestProjector = (*Service)(nil)
	_ plugin.WorkerProvider    = (*Service)(nil)
)

func (s *Service) Status(ctx context.Context) (plugin.Status, error) {
	var status plugin.Status
	var targeted bool
	var lastError string
	err := s.db.QueryRow(ctx, `SELECT
		COALESCE((SELECT enabled FROM alert_monitor WHERE singleton),FALSE),
		COALESCE((SELECT cardinality(areas)+cardinality(zones)>0 FROM alert_monitor WHERE singleton),FALSE),
		COALESCE((SELECT last_error_code FROM alert_monitor WHERE singleton AND enabled),''),
		(SELECT count(*) FROM alert_rules)`).Scan(&status.Active, &targeted, &lastError, &status.InstanceCount)
	if err != nil {
		return status, err
	}
	status.Configured = targeted || status.InstanceCount > 0
	if status.Active && status.InstanceCount == 0 {
		status.Attention = append(status.Attention, plugin.Attention{Code: "no_alert_rules", Message: "Monitoring is on but no alert rule will respond to a matching alert."})
	}
	if lastError != "" {
		status.Attention = append(status.Attention, plugin.Attention{Code: "poll_failing", Message: "The most recent National Weather Service poll did not succeed."})
	}
	return status, nil
}

func (s *Service) RemovalBlockers(ctx context.Context, tx pgx.Tx) ([]plugin.Blocker, error) {
	out := []plugin.Blocker{}
	for _, item := range []struct {
		kind, singular, plural string
		resolution             plugin.Resolution
		query                  string
	}{
		{"alert_monitor", "enabled monitor", "enabled monitors", plugin.ResolveDisable, `SELECT count(*) FROM alert_monitor WHERE enabled`},
		{"alert_rule", "alert rule", "alert rules", plugin.ResolveDelete, `SELECT count(*) FROM alert_rules`},
		{"alert_activation", "active alert", "active alerts", plugin.ResolveWait, `SELECT count(*) FROM alert_activations WHERE cleared_at IS NULL`},
	} {
		var count int
		if err := tx.QueryRow(ctx, item.query).Scan(&count); err != nil {
			return nil, err
		}
		out = append(out, plugin.Blocker{Kind: item.kind, Count: count, Singular: item.singular, Plural: item.plural, Resolution: item.resolution})
	}
	return out, nil
}

func (s *Service) Workers() []plugin.Worker {
	return []plugin.Worker{{Name: "nws-monitor", Run: s.RunWorker}}
}

type ManifestAlertTickerConfig struct {
	Name        string    `json:"name"`
	Message     string    `json:"message"`
	Severity    string    `json:"severity"`
	Event       string    `json:"event"`
	DisplayMode string    `json:"displayMode"`
	HeightPX    int       `json:"heightPx"`
	Speed       string    `json:"speed"`
	Priority    int       `json:"priority"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

func (s *Service) ProjectManifest(ctx context.Context, screenID uuid.UUID) ([]plugin.ManifestEntry, error) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT ON (a.rule_id) a.rule_id,r.name,
		left(COALESCE(NULLIF(concat_ws(' — ',NULLIF(a.event,''),NULLIF(a.headline,''),NULLIF(a.area_description,''),NULLIF(a.instruction,'')),''),'Active NWS weather alert'),1000),
		a.severity,a.event,r.ticker_display_mode,r.ticker_height_px,r.ticker_speed,a.expires_at
		FROM alert_activations a JOIN alert_rules r ON r.id=a.rule_id
		WHERE a.cleared_at IS NULL AND r.enabled AND r.response_mode='ticker' AND a.expires_at IS NOT NULL AND a.expires_at>now()
		ORDER BY a.rule_id, CASE a.severity WHEN 'Extreme' THEN 4 WHEN 'Severe' THEN 3 WHEN 'Moderate' THEN 2 WHEN 'Minor' THEN 1 ELSE 0 END DESC, a.first_seen_at`)
	if err != nil {
		return nil, err
	}
	type candidate struct {
		id     uuid.UUID
		config ManifestAlertTickerConfig
	}
	items := []candidate{}
	for rows.Next() {
		var item candidate
		item.config.Priority = 1000
		if err = rows.Scan(&item.id, &item.config.Name, &item.config.Message, &item.config.Severity, &item.config.Event, &item.config.DisplayMode, &item.config.HeightPX, &item.config.Speed, &item.config.ExpiresAt); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, item)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := []plugin.ManifestEntry{}
	for _, item := range items {
		tx, beginErr := s.db.Begin(ctx)
		if beginErr != nil {
			return nil, beginErr
		}
		targets, targetErr := ruleTargetsInTx(ctx, tx, item.id)
		_ = tx.Rollback(ctx)
		if targetErr != nil {
			return nil, targetErr
		}
		applies, applyErr := s.host.Targets.AppliesToScreen(ctx, screenID, targets)
		if applyErr != nil {
			return nil, applyErr
		}
		if applies {
			out = append(out, plugin.ManifestEntry{ID: item.id, Type: "alert_ticker", Version: 1, Config: item.config})
		}
	}
	return out, nil
}
