package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

const (
	nwsAlertsURL = "https://api.weather.gov/alerts/active"
	nwsZonesURL  = "https://api.weather.gov/zones"
)

var ErrValidation = errors.New("alert validation failed")

type alertValidationError struct{ message string }

func (e alertValidationError) Error() string { return e.message }
func (e alertValidationError) Unwrap() error { return ErrValidation }

func validationError(message string, args ...any) error {
	return alertValidationError{message: fmt.Sprintf(message, args...)}
}

type Monitor struct {
	Enabled             bool       `json:"enabled"`
	Areas               []string   `json:"areas"`
	Zones               []string   `json:"zones"`
	PollIntervalSeconds int        `json:"pollIntervalSeconds"`
	LastPolledAt        *time.Time `json:"lastPolledAt,omitempty"`
	LastSuccessAt       *time.Time `json:"lastSuccessAt,omitempty"`
	LastErrorCode       string     `json:"lastErrorCode,omitempty"`
	LastMatchedCount    int        `json:"lastMatchedCount"`
	UpdatedAt           time.Time  `json:"updatedAt"`
}

// A rule answers a matching alert in one of two ways. `takeover` replaces what
// is playing with fullscreen alert content and restores playback when the alert
// clears. `ticker` leaves playback running and delivers the alert as a bar
// through the Player's plugin channel — the same channel and the same
// overlay/push geometry the Countdown Bar uses.
type Rule struct {
	ID                     uuid.UUID   `json:"id"`
	Name                   string      `json:"name"`
	Enabled                bool        `json:"enabled"`
	EventNames             []string    `json:"eventNames"`
	MinimumSeverity        string      `json:"minimumSeverity"`
	MinimumUrgency         string      `json:"minimumUrgency"`
	ResponseMode           string      `json:"responseMode"`
	PresentationMode       string      `json:"presentationMode"`
	PlaylistID             *uuid.UUID  `json:"playlistId,omitempty"`
	PlaylistName           string      `json:"playlistName,omitempty"`
	TickerDisplayMode      string      `json:"tickerDisplayMode"`
	TickerHeightPX         int         `json:"tickerHeightPx"`
	TickerSpeed            string      `json:"tickerSpeed"`
	MaximumDurationMinutes int         `json:"maximumDurationMinutes"`
	ScreenIDs              []uuid.UUID `json:"screenIds"`
	GroupIDs               []uuid.UUID `json:"groupIds"`
	CreatedAt              time.Time   `json:"createdAt"`
	UpdatedAt              time.Time   `json:"updatedAt"`
	ManagedDataSourceID    *uuid.UUID  `json:"-"`
	ManagedWidgetID        *uuid.UUID  `json:"-"`
	ManagedPlaylistID      *uuid.UUID  `json:"-"`
}

type RuleInput struct {
	Name                   string      `json:"name"`
	Enabled                bool        `json:"enabled"`
	EventNames             []string    `json:"eventNames"`
	MinimumSeverity        string      `json:"minimumSeverity"`
	MinimumUrgency         string      `json:"minimumUrgency"`
	ResponseMode           string      `json:"responseMode"`
	PresentationMode       string      `json:"presentationMode"`
	PlaylistID             *uuid.UUID  `json:"playlistId"`
	TickerDisplayMode      string      `json:"tickerDisplayMode"`
	TickerHeightPX         int         `json:"tickerHeightPx"`
	TickerSpeed            string      `json:"tickerSpeed"`
	MaximumDurationMinutes int         `json:"maximumDurationMinutes"`
	ScreenIDs              []uuid.UUID `json:"screenIds"`
	GroupIDs               []uuid.UUID `json:"groupIds"`
}

type Zone struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	State string `json:"state"`
	Type  string `json:"type"`
}

type Activation struct {
	AlertID         string     `json:"alertId"`
	RuleID          uuid.UUID  `json:"ruleId"`
	RuleName        string     `json:"ruleName"`
	Event           string     `json:"event"`
	Headline        string     `json:"headline"`
	Severity        string     `json:"severity"`
	Urgency         string     `json:"urgency"`
	AreaDescription string     `json:"areaDescription"`
	ExpiresAt       *time.Time `json:"expiresAt,omitempty"`
	TakeoverID      *uuid.UUID `json:"takeoverId,omitempty"`
	FirstSeenAt     time.Time  `json:"firstSeenAt"`
	LastSeenAt      time.Time  `json:"lastSeenAt"`
}

type Service struct {
	host         plugin.Host
	db           plugin.DB
	client       *http.Client
	baseURL      string
	zonesBaseURL string
	logger       *slog.Logger
	userAgent    string
	maxDuration  time.Duration
	mu           sync.Mutex
}

func NewService() *Service { return &Service{} }

func (s *Service) Init(_ context.Context, host plugin.Host) error {
	s.host = host
	s.db = host.DB
	s.logger = host.Logger
	s.maxDuration = 24 * time.Hour
	if host.Takeovers != nil {
		s.maxDuration = host.Takeovers.MaximumDuration()
	}
	contact := ""
	if host.Instance != nil {
		contact = strings.TrimSpace(host.Instance.PublicURL())
	}
	if contact == "" {
		contact = "self-hosted Tilecast installation"
	}
	s.client = &http.Client{Timeout: 20 * time.Second}
	s.baseURL = nwsAlertsURL
	s.zonesBaseURL = nwsZonesURL
	s.userAgent = "Tilecast/1.0 (" + contact + ")"
	return nil
}

func (s *Service) Zones(ctx context.Context, area string) ([]Zone, error) {
	area = strings.ToUpper(strings.TrimSpace(area))
	if len(area) != 2 || area[0] < 'A' || area[0] > 'Z' || area[1] < 'A' || area[1] > 'Z' {
		return nil, validationError("select a valid state or territory")
	}
	seen := map[string]bool{}
	result := []Zone{}
	for _, zoneType := range []string{"county", "forecast"} {
		items, err := s.fetchZones(ctx, area, zoneType)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if item.ID == "" || seen[item.ID] {
				continue
			}
			seen[item.ID] = true
			result = append(result, item)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Type != result[j].Type {
			return result[i].Type < result[j].Type
		}
		if result[i].Name != result[j].Name {
			return result[i].Name < result[j].Name
		}
		return result[i].ID < result[j].ID
	})
	return result, nil
}

func (s *Service) fetchZones(ctx context.Context, area, zoneType string) ([]Zone, error) {
	requestURL, err := url.Parse(strings.TrimRight(s.zonesBaseURL, "/") + "/" + zoneType)
	if err != nil {
		return nil, err
	}
	query := requestURL.Query()
	query.Set("area", area)
	query.Set("include_geometry", "false")
	query.Set("limit", "500")
	requestURL.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/geo+json")
	req.Header.Set("User-Agent", s.userAgent)
	response, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("NWS zones returned HTTP %d", response.StatusCode)
	}
	var collection struct {
		Features []struct {
			ID         string `json:"id"`
			Properties Zone   `json:"properties"`
		} `json:"features"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&collection); err != nil {
		return nil, err
	}
	items := make([]Zone, 0, len(collection.Features))
	for _, feature := range collection.Features {
		item := feature.Properties
		if item.ID == "" {
			item.ID = feature.ID
		}
		if slash := strings.LastIndex(item.ID, "/"); slash >= 0 {
			item.ID = item.ID[slash+1:]
		}
		item.ID = strings.ToUpper(strings.TrimSpace(item.ID))
		item.Name = strings.TrimSpace(item.Name)
		item.State = strings.ToUpper(strings.TrimSpace(item.State))
		item.Type = zoneType
		items = append(items, item)
	}
	return items, nil
}

// RunWorker owns the NWS polling loop for the server lifetime.
func (s *Service) RunWorker(ctx context.Context) error {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			monitor, err := s.Monitor(ctx)
			installed := false
			if err == nil && monitor.Enabled {
				installed, err = s.host.Installation.Installed(ctx)
			}
			allowed := s.host.BackgroundJobs == nil || s.host.BackgroundJobs.Allowed()
			if err == nil && installed && monitor.Enabled && allowed {
				if err = s.Poll(ctx); err != nil && s.logger != nil {
					s.logger.Warn("NWS alert poll failed", "error", err)
				}
			}
			delay := 2 * time.Minute
			if monitor.PollIntervalSeconds >= 60 {
				delay = time.Duration(monitor.PollIntervalSeconds) * time.Second
			}
			timer.Reset(delay)
		}
	}
}

func (s *Service) Monitor(ctx context.Context) (Monitor, error) {
	var result Monitor
	err := s.db.QueryRow(ctx, `SELECT enabled,areas,zones,poll_interval_seconds,last_polled_at,last_success_at,COALESCE(last_error_code,''),last_matched_count,updated_at FROM alert_monitor WHERE singleton`).Scan(
		&result.Enabled, &result.Areas, &result.Zones, &result.PollIntervalSeconds, &result.LastPolledAt, &result.LastSuccessAt, &result.LastErrorCode, &result.LastMatchedCount, &result.UpdatedAt,
	)
	return result, err
}

func (s *Service) UpdateMonitor(ctx context.Context, enabled bool, areas, zones []string, interval int, userID uuid.UUID) (Monitor, error) {
	areas, err := normalizeCodes(areas, 2, "area")
	if err != nil {
		return Monitor{}, validationError("%v", err)
	}
	zones, err = normalizeCodes(zones, 6, "zone")
	if err != nil {
		return Monitor{}, validationError("%v", err)
	}
	if interval < 60 || interval > 3600 {
		return Monitor{}, validationError("poll interval must be between 60 and 3600 seconds")
	}
	if enabled && len(areas)+len(zones) == 0 {
		return Monitor{}, validationError("select at least one state, territory, county, or forecast zone")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Monitor{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err = s.host.Installation.LockInTx(ctx, tx); err != nil {
		return Monitor{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE alert_monitor SET enabled=$1,areas=$2,zones=$3,poll_interval_seconds=$4,updated_by=$5,updated_at=now() WHERE singleton`, enabled, areas, zones, interval, userID)
	if err != nil {
		return Monitor{}, err
	}
	if err = s.host.Audit.RecordInTx(ctx, tx, plugin.AuditEvent{UserID: userID, Action: "nws_monitor.updated", ResourceType: "nws_alert_monitor", ResourceID: "singleton", Metadata: map[string]any{"enabled": enabled, "areas": areas, "zones": zones}}); err != nil {
		return Monitor{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Monitor{}, err
	}
	return s.Monitor(ctx)
}

func normalizeCodes(values []string, length int, label string) ([]string, error) {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.ToUpper(strings.TrimSpace(value))
		if value == "" {
			continue
		}
		if len(value) != length {
			return nil, fmt.Errorf("%s code %q must be %d characters", label, value, length)
		}
		for _, char := range value {
			if (char < 'A' || char > 'Z') && (char < '0' || char > '9') {
				return nil, fmt.Errorf("%s code %q is invalid", label, value)
			}
		}
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result, nil
}

func (s *Service) Rules(ctx context.Context) ([]Rule, error) {
	rows, err := s.db.Query(ctx, `SELECT r.id,r.name,r.enabled,r.event_names,r.minimum_severity,r.minimum_urgency,r.response_mode,r.presentation_mode,r.playlist_id,'' AS playlist_name,r.ticker_display_mode,r.ticker_height_px,r.ticker_speed,r.maximum_duration_minutes,r.created_at,r.updated_at,r.managed_data_source_id,r.managed_widget_id,r.managed_playlist_id,
		COALESCE(array_agg(t.screen_id) FILTER (WHERE t.screen_id IS NOT NULL),'{}'),COALESCE(array_agg(t.screen_group_id) FILTER (WHERE t.screen_group_id IS NOT NULL),'{}')
		FROM alert_rules r LEFT JOIN alert_rule_targets t ON t.rule_id=r.id
		GROUP BY r.id ORDER BY r.position,r.name,r.id`)
	if err != nil {
		return nil, err
	}
	result := []Rule{}
	for rows.Next() {
		var rule Rule
		if err = rows.Scan(&rule.ID, &rule.Name, &rule.Enabled, &rule.EventNames, &rule.MinimumSeverity, &rule.MinimumUrgency, &rule.ResponseMode, &rule.PresentationMode, &rule.PlaylistID, &rule.PlaylistName, &rule.TickerDisplayMode, &rule.TickerHeightPX, &rule.TickerSpeed, &rule.MaximumDurationMinutes, &rule.CreatedAt, &rule.UpdatedAt, &rule.ManagedDataSourceID, &rule.ManagedWidgetID, &rule.ManagedPlaylistID, &rule.ScreenIDs, &rule.GroupIDs); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, rule)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for i := range result {
		if result[i].PlaylistID != nil {
			name, nameErr := s.host.ManagedPresentations.PlaylistName(ctx, *result[i].PlaylistID)
			if nameErr == nil {
				result[i].PlaylistName = name
			}
		}
	}
	return result, nil
}

func (s *Service) SaveRule(ctx context.Context, id uuid.UUID, input RuleInput, userID uuid.UUID) (Rule, error) {
	// Checked before any managed presentation is provisioned, then again under
	// lock in the transaction that writes the rule.
	if err := s.host.Installation.Require(ctx); err != nil {
		return Rule{}, err
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 180 {
		return Rule{}, validationError("rule name is required and must be at most 180 characters")
	}
	if !rankContains(severityRank, input.MinimumSeverity) || !rankContains(urgencyRank, input.MinimumUrgency) {
		return Rule{}, validationError("severity or urgency is invalid")
	}
	if input.PresentationMode == "" {
		if input.PlaylistID != nil && *input.PlaylistID != uuid.Nil {
			input.PresentationMode = "playlist"
		} else {
			input.PresentationMode = "builtin"
		}
	}
	if input.PresentationMode != "builtin" && input.PresentationMode != "playlist" {
		return Rule{}, validationError("presentation mode is invalid")
	}
	if input.ResponseMode == "" {
		input.ResponseMode = "takeover"
	}
	if input.ResponseMode != "takeover" && input.ResponseMode != "ticker" {
		return Rule{}, validationError("response mode is invalid")
	}
	// Bar geometry is stored for every rule, whether or not it currently answers
	// with a bar, so switching a rule to a ticker and back does not lose the
	// shape it was last given.
	if input.TickerDisplayMode == "" {
		input.TickerDisplayMode = "push"
	}
	if input.TickerHeightPX == 0 {
		input.TickerHeightPX = 96
	}
	if input.TickerSpeed == "" {
		input.TickerSpeed = "medium"
	}
	if input.TickerDisplayMode != "overlay" && input.TickerDisplayMode != "push" {
		return Rule{}, validationError("ticker display mode must be overlay or push")
	}
	if input.TickerHeightPX < 40 || input.TickerHeightPX > 320 {
		return Rule{}, validationError("ticker height must be between 40 and 320 pixels")
	}
	if input.TickerSpeed != "slow" && input.TickerSpeed != "medium" && input.TickerSpeed != "fast" {
		return Rule{}, validationError("ticker speed must be slow, medium, or fast")
	}
	if input.ResponseMode == "ticker" {
		// A ticker is the live alert itself rendered as a bar. A custom playlist
		// is fullscreen content by nature, so asking for both is a contradiction
		// rather than something to resolve silently in one direction.
		if input.PresentationMode == "playlist" || (input.PlaylistID != nil && *input.PlaylistID != uuid.Nil) {
			return Rule{}, validationError("a ticker response shows the live alert and cannot use a custom playlist")
		}
		input.PresentationMode = "builtin"
		input.PlaylistID = nil
	}
	if input.PresentationMode == "playlist" && (input.PlaylistID == nil || *input.PlaylistID == uuid.Nil) {
		return Rule{}, validationError("select a ready, non-empty playlist")
	}
	if input.MaximumDurationMinutes < 5 || input.MaximumDurationMinutes > int(s.maxDuration/time.Minute) {
		return Rule{}, validationError("maximum duration must be between 5 and %d minutes", int(s.maxDuration/time.Minute))
	}
	if len(input.ScreenIDs)+len(input.GroupIDs) == 0 {
		return Rule{}, validationError("select at least one screen or group")
	}
	events := make([]string, 0, len(input.EventNames))
	for _, event := range input.EventNames {
		event = strings.TrimSpace(event)
		if event != "" && len(event) <= 120 {
			events = append(events, event)
		}
	}
	creating := id == uuid.Nil
	if creating {
		id = uuid.New()
	}
	input.ScreenIDs = uniqueUUIDs(input.ScreenIDs)
	input.GroupIDs = uniqueUUIDs(input.GroupIDs)
	targets := plugin.ScreenTargets{ScreenIDs: input.ScreenIDs, GroupIDs: input.GroupIDs}
	organizationID, err := s.host.Organization.ID(ctx)
	if err != nil {
		return Rule{}, err
	}
	var managedDataSourceID, managedWidgetID, managedPlaylistID *uuid.UUID
	var previousResponseMode string
	if !creating {
		err = s.db.QueryRow(ctx, `SELECT response_mode,managed_data_source_id,managed_widget_id,managed_playlist_id FROM alert_rules WHERE id=$1 AND organization_id=$2`, id, organizationID).Scan(&previousResponseMode, &managedDataSourceID, &managedWidgetID, &managedPlaylistID)
		if err != nil {
			return Rule{}, err
		}
	}
	if input.ResponseMode != "ticker" && input.PresentationMode == "playlist" {
		if err = s.host.Takeovers.ValidatePlaylist(ctx, *input.PlaylistID, targets, true); err != nil {
			return Rule{}, validationError("select a ready, non-empty playlist")
		}
	}
	tickerInvolved := input.ResponseMode == "ticker" || previousResponseMode == "ticker"
	var previousScreenIDs []uuid.UUID
	if tickerInvolved && !creating {
		if previousScreenIDs, err = s.ruleScreenIDs(ctx, id); err != nil {
			return Rule{}, err
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Rule{}, err
	}
	defer tx.Rollback(ctx)
	if err = s.host.Installation.LockInTx(ctx, tx); err != nil {
		return Rule{}, err
	}
	if err = s.host.Targets.ValidateScreenTargetsInTx(ctx, tx, targets); err != nil {
		return Rule{}, validationError("one or more targets do not exist")
	}
	if input.ResponseMode != "ticker" && input.PresentationMode == "builtin" {
		configuration, payload := builtinAlertDocuments(nwsProperties{}, time.Time{}, time.Now().UTC())
		managed, ensureErr := s.host.ManagedPresentations.EnsureInTx(ctx, tx,
			plugin.ManagedPresentation{DataSourceID: idOrNil(managedDataSourceID), WidgetID: idOrNil(managedWidgetID), PlaylistID: idOrNil(managedPlaylistID)},
			plugin.ManagedPresentationRequest{
				Name: "NWS emergency presentation", Description: "Built in for NWS rule " + id.String(),
				DataSourceProvider: "emergency-message", DataSourceConfiguration: configuration,
				CachedPayload: payload, CacheCategory: "nws", CreatedBy: userID,
				WidgetProvider: "alert-banner",
				WidgetConfiguration: func(source uuid.UUID) string {
					value, _ := json.Marshal(map[string]any{"dataSourceId": source.String(), "messageField": "message", "severityField": "severity", "speed": "slow", "showSeverity": true, "foregroundColor": "#ffffff", "backgroundColor": "#7a1f1f", "emptyState": "Waiting for an active NWS alert"})
					return string(value)
				},
			})
		if ensureErr != nil {
			return Rule{}, ensureErr
		}
		managedDataSourceID, managedWidgetID, managedPlaylistID = &managed.DataSourceID, &managed.WidgetID, &managed.PlaylistID
		input.PlaylistID = managedPlaylistID
	}
	var tag pgconn.CommandTag
	if creating {
		tag, err = tx.Exec(ctx, `INSERT INTO alert_rules(id,organization_id,name,enabled,event_names,minimum_severity,minimum_urgency,response_mode,presentation_mode,playlist_id,ticker_display_mode,ticker_height_px,ticker_speed,maximum_duration_minutes,created_by,managed_data_source_id,managed_widget_id,managed_playlist_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			id, organizationID, input.Name, input.Enabled, events, input.MinimumSeverity, input.MinimumUrgency, input.ResponseMode, input.PresentationMode, input.PlaylistID, input.TickerDisplayMode, input.TickerHeightPX, input.TickerSpeed, input.MaximumDurationMinutes, userID, managedDataSourceID, managedWidgetID, managedPlaylistID)
	} else {
		tag, err = tx.Exec(ctx, `UPDATE alert_rules SET name=$3,enabled=$4,event_names=$5,minimum_severity=$6,minimum_urgency=$7,response_mode=$8,presentation_mode=$9,playlist_id=$10,ticker_display_mode=$11,ticker_height_px=$12,ticker_speed=$13,maximum_duration_minutes=$14,managed_data_source_id=$15,managed_widget_id=$16,managed_playlist_id=$17,updated_at=now()
			WHERE id=$1 AND organization_id=$2`,
			id, organizationID, input.Name, input.Enabled, events, input.MinimumSeverity, input.MinimumUrgency, input.ResponseMode, input.PresentationMode, input.PlaylistID, input.TickerDisplayMode, input.TickerHeightPX, input.TickerSpeed, input.MaximumDurationMinutes, managedDataSourceID, managedWidgetID, managedPlaylistID)
	}
	if err != nil {
		return Rule{}, err
	}
	if tag.RowsAffected() == 0 {
		return Rule{}, pgx.ErrNoRows
	}
	if _, err = tx.Exec(ctx, `DELETE FROM alert_rule_targets WHERE rule_id=$1`, id); err != nil {
		return Rule{}, err
	}
	for _, screenID := range uniqueUUIDs(input.ScreenIDs) {
		if _, err = tx.Exec(ctx, `INSERT INTO alert_rule_targets(rule_id,target_type,screen_id) VALUES($1,'screen',$2)`, id, screenID); err != nil {
			return Rule{}, err
		}
	}
	for _, groupID := range uniqueUUIDs(input.GroupIDs) {
		if _, err = tx.Exec(ctx, `INSERT INTO alert_rule_targets(rule_id,target_type,screen_group_id) VALUES($1,'group',$2)`, id, groupID); err != nil {
			return Rule{}, err
		}
	}
	if err = s.host.Audit.RecordInTx(ctx, tx, plugin.AuditEvent{UserID: userID, Action: "nws_alert_rule.saved", ResourceType: "nws_alert_rule", ResourceID: id.String()}); err != nil {
		return Rule{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Rule{}, err
	}
	// Changing how a rule answers cannot be applied to an alert already being
	// answered the old way: a takeover has to be released and a bar withdrawn.
	// Clearing the rule's live activations lets the next poll re-answer the same
	// alert in the new form, and the poller is idempotent by alert identifier.
	if !creating && previousResponseMode != input.ResponseMode {
		if err = s.clearRuleActivations(ctx, id, "rule_changed"); err != nil {
			return Rule{}, err
		}
	}
	// A ticker's screens need a new manifest to see an edit at all — a changed
	// height, speed, or target set — and so do the screens the edit dropped.
	if tickerInvolved {
		currentScreenIDs, screenErr := s.ruleScreenIDs(ctx, id)
		if screenErr != nil {
			return Rule{}, screenErr
		}
		if err = s.bumpScreens(ctx, uniqueUUIDs(append(previousScreenIDs, currentScreenIDs...)), "nws.rule.saved"); err != nil {
			return Rule{}, err
		}
	}
	rules, err := s.Rules(ctx)
	if err != nil {
		return Rule{}, err
	}
	for _, rule := range rules {
		if rule.ID == id {
			return rule, nil
		}
	}
	return Rule{}, pgx.ErrNoRows
}

func (s *Service) DeleteRule(ctx context.Context, id, userID uuid.UUID) error {
	// Read the targets before the delete cascades them away: a ticker rule's bar
	// only leaves the screens that are told to fetch a manifest without it.
	screenIDs, err := s.ruleScreenIDs(ctx, id)
	if err != nil {
		return err
	}
	if err = s.clearRuleActivations(ctx, id, "rule_deleted"); err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM alert_rules WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	if err = s.host.Audit.RecordInTx(ctx, tx, plugin.AuditEvent{UserID: userID, Action: "nws_alert_rule.deleted", ResourceType: "nws_alert_rule", ResourceID: id.String()}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if err = s.bumpScreens(ctx, screenIDs, "nws.rule.deleted"); err != nil {
		return err
	}
	return nil
}

func (s *Service) Activations(ctx context.Context) ([]Activation, error) {
	rows, err := s.db.Query(ctx, `SELECT a.alert_id,a.rule_id,r.name,a.event,a.headline,a.severity,a.urgency,a.area_description,a.expires_at,a.takeover_id,a.first_seen_at,a.last_seen_at
		FROM alert_activations a JOIN alert_rules r ON r.id=a.rule_id WHERE a.cleared_at IS NULL ORDER BY a.first_seen_at DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Activation{}
	for rows.Next() {
		var item Activation
		if err = rows.Scan(&item.AlertID, &item.RuleID, &item.RuleName, &item.Event, &item.Headline, &item.Severity, &item.Urgency, &item.AreaDescription, &item.ExpiresAt, &item.TakeoverID, &item.FirstSeenAt, &item.LastSeenAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

type nwsCollection struct {
	Features []struct {
		ID         string        `json:"id"`
		Properties nwsProperties `json:"properties"`
	} `json:"features"`
}

type nwsProperties struct {
	ID              string     `json:"id"`
	Event           string     `json:"event"`
	Headline        string     `json:"headline"`
	Description     string     `json:"description"`
	Instruction     string     `json:"instruction"`
	Severity        string     `json:"severity"`
	Urgency         string     `json:"urgency"`
	Certainty       string     `json:"certainty"`
	AreaDescription string     `json:"areaDesc"`
	SenderName      string     `json:"senderName"`
	Effective       *time.Time `json:"effective"`
	Expires         *time.Time `json:"expires"`
	Ends            *time.Time `json:"ends"`
	Status          string     `json:"status"`
	MessageType     string     `json:"messageType"`
}

func (s *Service) Poll(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.host.Installation.Require(ctx); err != nil {
		return err
	}
	monitor, err := s.Monitor(ctx)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	_, _ = s.db.Exec(ctx, `UPDATE alert_monitor SET last_polled_at=$1 WHERE singleton`, now)
	var collection nwsCollection
	// Area and zone are separate NWS query dimensions. Fetch them separately
	// and union by alert identifier; sending both in one request would mean an
	// intersection and could silently omit a configured county.
	scopes := [][2]string{}
	if len(monitor.Areas) > 0 {
		scopes = append(scopes, [2]string{"area", strings.Join(monitor.Areas, ",")})
	}
	if len(monitor.Zones) > 0 {
		scopes = append(scopes, [2]string{"zone", strings.Join(monitor.Zones, ",")})
	}
	if len(scopes) == 0 {
		scopes = append(scopes, [2]string{})
	}
	featureIDs := map[string]bool{}
	for _, scope := range scopes {
		part, fetchErr := s.fetch(ctx, scope[0], scope[1])
		if fetchErr != nil {
			return fetchErr
		}
		for _, feature := range part.Features {
			id := feature.Properties.ID
			if id == "" {
				id = feature.ID
			}
			if !featureIDs[id] {
				featureIDs[id] = true
				collection.Features = append(collection.Features, feature)
			}
		}
	}
	rules, err := s.Rules(ctx)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	matched := 0
	var applyErr error
	for _, feature := range collection.Features {
		if !nwsAlertActive(feature.Properties, now) {
			continue
		}
		alertID := strings.TrimSpace(feature.Properties.ID)
		if alertID == "" {
			alertID = strings.TrimSpace(feature.ID)
		}
		if alertID == "" {
			continue
		}
		for _, rule := range rules {
			if !rule.Enabled || !matches(rule, feature.Properties.Event, feature.Properties.Severity, feature.Properties.Urgency) {
				continue
			}
			key := alertID + "\x00" + rule.ID.String()
			seen[key] = true
			matched++
			if err = s.applyAlert(ctx, alertID, rule, feature.Properties, now); err != nil {
				if applyErr == nil {
					applyErr = err
				}
				if s.logger != nil {
					s.logger.Error("apply NWS alert failed", "rule_id", rule.ID, "error", err)
				}
			}
		}
	}
	if err = s.clearMissing(ctx, seen, now); err != nil {
		return err
	}
	if applyErr != nil {
		_, err = s.db.Exec(ctx, `UPDATE alert_monitor SET last_error_code='alert_apply_failed',last_matched_count=$1 WHERE singleton`, matched)
	} else {
		_, err = s.db.Exec(ctx, `UPDATE alert_monitor SET last_success_at=$1,last_error_code=NULL,last_matched_count=$2 WHERE singleton`, now, matched)
	}
	if err == nil && applyErr != nil {
		return fmt.Errorf("apply one or more NWS alert rules: %w", applyErr)
	}
	return err
}

func nwsAlertActive(alert nwsProperties, now time.Time) bool {
	end := alert.Expires
	if alert.Ends != nil {
		end = alert.Ends
	}
	return end == nil || end.After(now)
}

func (s *Service) fetch(ctx context.Context, filter, value string) (nwsCollection, error) {
	requestURL, err := url.Parse(s.baseURL)
	if err != nil {
		return nwsCollection{}, fmt.Errorf("parse NWS base URL: %w", err)
	}
	query := requestURL.Query()
	if filter != "" {
		query.Set(filter, value)
	}
	query.Set("status", "actual")
	query.Set("message_type", "alert")
	requestURL.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nwsCollection{}, fmt.Errorf("create NWS request: %w", err)
	}
	req.Header.Set("Accept", "application/geo+json")
	req.Header.Set("User-Agent", s.userAgent)
	response, err := s.client.Do(req)
	if err != nil {
		s.recordPollFailure(ctx, "nws_unreachable")
		return nwsCollection{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		s.recordPollFailure(ctx, fmt.Sprintf("nws_http_%d", response.StatusCode))
		return nwsCollection{}, fmt.Errorf("NWS returned HTTP %d", response.StatusCode)
	}
	var collection nwsCollection
	if err = json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&collection); err != nil {
		s.recordPollFailure(ctx, "nws_invalid_response")
		return nwsCollection{}, err
	}
	return collection, nil
}

func (s *Service) recordPollFailure(ctx context.Context, code string) {
	_, _ = s.db.Exec(ctx, `UPDATE alert_monitor SET last_error_code=$1 WHERE singleton`, code)
}

func matches(rule Rule, event, severity, urgency string) bool {
	if severityRank[severity] < severityRank[rule.MinimumSeverity] || urgencyRank[urgency] < urgencyRank[rule.MinimumUrgency] {
		return false
	}
	if len(rule.EventNames) == 0 {
		return true
	}
	for _, name := range rule.EventNames {
		if strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(event)) {
			return true
		}
	}
	return false
}

var severityRank = map[string]int{"Minor": 1, "Moderate": 2, "Severe": 3, "Extreme": 4}
var urgencyRank = map[string]int{"Unknown": 0, "Future": 1, "Expected": 2, "Immediate": 3}

func rankContains(values map[string]int, value string) bool {
	_, ok := values[value]
	return ok
}

func uniqueUUIDs(values []uuid.UUID) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	result := []uuid.UUID{}
	for _, value := range values {
		if value != uuid.Nil && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func idOrNil(value *uuid.UUID) uuid.UUID {
	if value == nil {
		return uuid.Nil
	}
	return *value
}
