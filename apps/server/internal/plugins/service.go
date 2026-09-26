package plugins

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	bundled "github.com/tilecast/tilecast/plugins"
)

// The SDK's sentinel errors, so a plugin and the legacy built-ins in this
// package answer with the same API errors.
var (
	ErrNotFound = plugin.ErrNotFound
	ErrInvalid  = plugin.ErrInvalid
)

type Notifier interface{ ManifestChanged(uuid.UUID, int64) }

// ManifestInvalidator is implemented by the playlist service so plugin
// mutations use the same transactional dependency-version traversal as media,
// layouts, schedules, and presentation overrides.
type ManifestInvalidator interface {
	InvalidatePluginInTx(context.Context, pgx.Tx, string, uuid.UUID, string, func(uuid.UUID, int64)) error
}

type Service struct {
	db          *pgxpool.Pool
	notifier    Notifier
	invalidator ManifestInvalidator
	logger      *slog.Logger
	clock       plugin.Clock

	bundle      []plugin.Plugin
	definitions []Definition
	hosted      []hostedPlugin
}

// NewService hosts the plugins bundled with this release, or the ones given
// with WithPlugins, and initializes each of them.
func NewService(db *pgxpool.Pool, notifier Notifier, options ...Option) *Service {
	s := &Service{db: db, notifier: notifier, logger: slog.Default(), clock: systemClock{}}
	for _, option := range options {
		option(s)
	}
	if s.bundle == nil {
		s.bundle = bundled.Bundled()
	}
	s.host()
	return s
}

func (s *Service) SetManifestInvalidator(invalidator ManifestInvalidator) {
	s.invalidator = invalidator
}

// CatalogPlugin is one registry definition joined with this installation's
// state. Installed, configured, and active are separate questions: an installed
// Emergency Alerts plugin with monitoring switched off is valid, and a plugin is
// never "enabled" by being installed.
type CatalogPlugin struct {
	ID          string `json:"id"`
	Version     int    `json:"version"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Icon        string `json:"icon"`

	ManagementPath string `json:"managementPath"`

	InstanceNounSingular string `json:"instanceNounSingular"`
	InstanceNounPlural   string `json:"instanceNounPlural"`

	Requirements  []Requirement `json:"requirements"`
	Capabilities  []string      `json:"capabilities"`
	Documentation string        `json:"documentation,omitempty"`

	Installed   bool `json:"installed"`
	Installable bool `json:"installable"`

	Configured    bool `json:"configured"`
	Active        bool `json:"active"`
	InstanceCount int  `json:"instanceCount"`

	Attention []PluginAttention `json:"attention"`
}

// PluginAttention is a bounded, advisory status note. It never blocks
// installation or configuration.
type PluginAttention struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Catalog struct {
	Items []CatalogPlugin `json:"items"`
	// UnsupportedInstallations are installation rows this release does not
	// recognize. They are preserved and inert.
	UnsupportedInstallations []UnsupportedInstallation `json:"unsupportedInstallations"`
}

type CountdownBarInput struct {
	Name                string      `json:"name"`
	Message             string      `json:"message"`
	ScheduleType        string      `json:"scheduleType"`
	TargetTime          *string     `json:"targetTime,omitempty"`
	DaysOfWeek          []int       `json:"daysOfWeek"`
	OneTimeAt           *time.Time  `json:"oneTimeAt,omitempty"`
	Timezone            string      `json:"timezone"`
	LeadTimeSeconds     int         `json:"leadTimeSeconds"`
	CompletionText      string      `json:"completionText"`
	ShowConfetti        bool        `json:"showConfetti"`
	DisplayMode         string      `json:"displayMode"`
	HeightPX            int         `json:"heightPx"`
	ProgressFill        string      `json:"progressFill"`
	ContentPadding      *int        `json:"contentPadding"`
	TextScale           int         `json:"textScale"`
	UrgencyEnabled      bool        `json:"urgencyEnabled"`
	StartingSoonSeconds int         `json:"startingSoonSeconds"`
	UrgentSeconds       int         `json:"urgentSeconds"`
	PulseSeconds        int         `json:"pulseSeconds"`
	Enabled             bool        `json:"enabled"`
	Priority            int         `json:"priority"`
	TargetScope         string      `json:"targetScope"`
	TargetIDs           []uuid.UUID `json:"targetIds"`
}

type CountdownBar struct {
	ID uuid.UUID `json:"id"`
	CountdownBarInput
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ManifestPlugin is one entry of the manifest's discriminated `plugins`
// array: a screen may be delivered a Countdown Bar, an Emergency Alerts
// ticker, and a Brand Bug at the same time. It is the SDK's ManifestEntry,
// so plugins in plugins/ and the remaining built-ins here share one shape.
type ManifestPlugin = plugin.ManifestEntry

type ManifestCountdownConfig struct {
	Name                string     `json:"name"`
	Message             string     `json:"message"`
	ScheduleType        string     `json:"scheduleType"`
	TargetTime          *string    `json:"targetTime,omitempty"`
	DaysOfWeek          []int      `json:"daysOfWeek,omitempty"`
	OneTimeAt           *time.Time `json:"oneTimeAt,omitempty"`
	Timezone            string     `json:"timezone"`
	LeadTimeSeconds     int        `json:"leadTimeSeconds"`
	CompletionText      string     `json:"completionText,omitempty"`
	ShowConfetti        bool       `json:"showConfetti"`
	DisplayMode         string     `json:"displayMode"`
	HeightPX            int        `json:"heightPx"`
	ProgressFill        string     `json:"progressFill"`
	ContentPadding      int        `json:"contentPadding"`
	TextScale           int        `json:"textScale"`
	UrgencyEnabled      bool       `json:"urgencyEnabled"`
	StartingSoonSeconds int        `json:"startingSoonSeconds"`
	UrgentSeconds       int        `json:"urgentSeconds"`
	PulseSeconds        int        `json:"pulseSeconds"`
	Priority            int        `json:"priority"`
}

// ManifestAlertTickerConfig carries one live NWS alert as a bar rather than as a
// takeover. The message is composed server-side from the same alert fields the
// built-in fullscreen presentation shows, so a site that switches a rule from
// fullscreen to ticker reads the same alert either way.
//
// `expiresAt` is what ends the bar. The poller clears an activation as soon as
// the alert stops matching, but a player running on a cached manifest has no
// poller to hear from: the expiry lets it take the bar down on its own rather
// than display an alert that may be over.
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

// An emergency outranks every configured bar. Priority is published rather than
// implied so a player only has to compare one field to decide what shows.
const alertTickerPriority = 1000

// pluginStatus is the plugin-specific part of a catalog entry.
type pluginStatus struct {
	configured bool
	active     bool
	count      int
	attention  []PluginAttention
}

// Catalog reports every plugin this release can run with its installation and
// status. A plugin that is not installed still appears: the catalog is the list
// of what Tilecast can do, and Studio decides how to separate installed from
// available.
func (s *Service) Catalog(ctx context.Context) (Catalog, error) {
	installed, unsupported, err := s.installations(ctx)
	if err != nil {
		return Catalog{}, err
	}
	statuses, err := s.pluginStatuses(ctx)
	if err != nil {
		return Catalog{}, err
	}
	items := []CatalogPlugin{}
	for _, hosted := range s.hosted {
		status, reported, err := reportedStatus(ctx, hosted)
		if err != nil {
			return Catalog{}, err
		}
		if !reported {
			status = statuses[hosted.manifest.ID]
		}
		items = append(items, catalogEntry(hosted.definition, installed[hosted.manifest.ID], status))
	}
	return Catalog{Items: items, UnsupportedInstallations: unsupported}, nil
}

// CatalogItem reports one known plugin in the catalog shape.
func (s *Service) CatalogItem(ctx context.Context, id string) (CatalogPlugin, error) {
	catalog, err := s.Catalog(ctx)
	if err != nil {
		return CatalogPlugin{}, err
	}
	for _, item := range catalog.Items {
		if item.ID == id {
			return item, nil
		}
	}
	return CatalogPlugin{}, ErrPluginNotFound
}

// reportedStatus asks a plugin that reports its own status.
func reportedStatus(ctx context.Context, hosted hostedPlugin) (pluginStatus, bool, error) {
	reporter, ok := hosted.plugin.(plugin.StatusReporter)
	if !ok {
		return pluginStatus{}, false, nil
	}
	reported, err := reporter.Status(ctx)
	if err != nil {
		return pluginStatus{}, true, fmt.Errorf("plugin %s: status: %w", hosted.manifest.ID, err)
	}
	status := pluginStatus{configured: reported.Configured, active: reported.Active, count: reported.InstanceCount}
	for _, note := range reported.Attention {
		status.attention = append(status.attention, PluginAttention{Code: note.Code, Message: note.Message})
	}
	return status, true, nil
}

func catalogEntry(d Definition, installed bool, status pluginStatus) CatalogPlugin {
	requirements := append([]Requirement{}, d.Requirements...)
	capabilities := append([]string{}, d.Capabilities...)
	attention := []PluginAttention{}
	if installed {
		attention = append(attention, status.attention...)
	} else if status.count > 0 {
		// Feature data without an installation does nothing at runtime. Say so,
		// rather than letting the data look like a working feature.
		attention = append(attention, PluginAttention{
			Code:    "data_without_installation",
			Message: fmt.Sprintf("%d %s exist but %s is not installed, so they have no effect.", status.count, nounFor(d, status.count), d.Name),
		})
	}
	return CatalogPlugin{
		ID: d.ID, Version: d.Version, Name: d.Name, Description: d.Description,
		Category: d.Category, Icon: d.Icon, ManagementPath: d.ManagementPath,
		InstanceNounSingular: d.InstanceNounSingular, InstanceNounPlural: d.InstanceNounPlural,
		Requirements: requirements, Capabilities: capabilities, Documentation: d.Documentation,
		Installed: installed, Installable: d.Installable,
		Configured: status.configured, Active: status.active, InstanceCount: status.count,
		Attention: attention,
	}
}

func nounFor(d Definition, count int) string {
	if count == 1 {
		return d.InstanceNounSingular
	}
	return d.InstanceNounPlural
}

// pluginStatuses reads each plugin's own tables. The rules are deliberately
// plugin-specific; see docs/plugins.md for what configured and active mean for
// each one.
func (s *Service) pluginStatuses(ctx context.Context) (map[string]pluginStatus, error) {
	statuses := map[string]pluginStatus{}
	for id, table := range map[string]string{
		CountdownBarID: "countdown_bar_instances",
		BrandBugID:     "brand_bug_instances",
		NoiseMeterID:   "noise_meter_instances",
	} {
		var status pluginStatus
		// table is a literal from this map, never request input.
		if err := s.db.QueryRow(ctx, `SELECT COALESCE(bool_or(enabled),FALSE),count(*) FROM `+table).
			Scan(&status.active, &status.count); err != nil {
			return nil, err
		}
		status.configured = status.count > 0
		statuses[id] = status
	}

	noise := statuses[NoiseMeterID]
	var linuxPlayers bool
	if err := s.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM screens WHERE platform='linux' AND archived_at IS NULL)`).
		Scan(&linuxPlayers); err != nil {
		return nil, err
	}
	if !linuxPlayers {
		noise.attention = append(noise.attention, PluginAttention{
			Code:    "no_compatible_player",
			Message: "No Linux Player is paired yet. Meters take effect once a Linux Player with a microphone is added.",
		})
	}
	statuses[NoiseMeterID] = noise

	// Emergency Alerts is active when its monitor is switched on, and its rules
	// are its instances. A monitor with areas chosen but no rule is configured
	// but will never respond, which is worth pointing out.
	var alerts pluginStatus
	var targeted bool
	var lastError string
	if err := s.db.QueryRow(ctx, `SELECT
		COALESCE((SELECT enabled FROM alert_monitor WHERE singleton),FALSE),
		COALESCE((SELECT cardinality(areas)+cardinality(zones)>0 FROM alert_monitor WHERE singleton),FALSE),
		COALESCE((SELECT last_error_code FROM alert_monitor WHERE singleton AND enabled),''),
		(SELECT count(*) FROM alert_rules)`).Scan(&alerts.active, &targeted, &lastError, &alerts.count); err != nil {
		return nil, err
	}
	alerts.configured = targeted || alerts.count > 0
	if alerts.active && alerts.count == 0 {
		alerts.attention = append(alerts.attention, PluginAttention{
			Code: "no_alert_rules", Message: "Monitoring is on but no alert rule will respond to a matching alert.",
		})
	}
	if lastError != "" {
		alerts.attention = append(alerts.attention, PluginAttention{
			Code: "poll_failing", Message: "The most recent National Weather Service poll did not succeed.",
		})
	}
	statuses[EmergencyAlertsID] = alerts

	var forms pluginStatus
	if err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM data_sources WHERE provider='form' AND deleted_at IS NULL`).
		Scan(&forms.count); err != nil {
		return nil, err
	}
	forms.configured = forms.count > 0
	forms.active = forms.count > 0
	statuses[FormsID] = forms
	return statuses, nil
}

func (s *Service) ListCountdownBars(ctx context.Context) ([]CountdownBar, error) {
	rows, err := s.db.Query(ctx, `SELECT id,name,message,schedule_type,target_time::text,days_of_week,one_time_at,timezone,
		lead_time_seconds,completion_text,show_confetti,display_mode,height_px,progress_fill,content_padding,text_scale,
		urgency_enabled,starting_soon_seconds,urgent_seconds,pulse_seconds,enabled,priority,target_scope,created_at,updated_at
		FROM countdown_bar_instances ORDER BY priority DESC,lower(name),id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CountdownBar{}
	for rows.Next() {
		item, err := scanCountdownBar(rows)
		if err != nil {
			return nil, err
		}
		item.TargetIDs, err = s.targetIDs(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) GetCountdownBar(ctx context.Context, id uuid.UUID) (CountdownBar, error) {
	row := s.db.QueryRow(ctx, `SELECT id,name,message,schedule_type,target_time::text,days_of_week,one_time_at,timezone,
		lead_time_seconds,completion_text,show_confetti,display_mode,height_px,progress_fill,content_padding,text_scale,
		urgency_enabled,starting_soon_seconds,urgent_seconds,pulse_seconds,enabled,priority,target_scope,created_at,updated_at
		FROM countdown_bar_instances WHERE id=$1`, id)
	item, err := scanCountdownBar(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return CountdownBar{}, ErrNotFound
	}
	if err != nil {
		return CountdownBar{}, err
	}
	item.TargetIDs, err = s.targetIDs(ctx, id)
	return item, err
}

type scanner interface{ Scan(...any) error }

func scanCountdownBar(row scanner) (CountdownBar, error) {
	var item CountdownBar
	var targetTime *string
	var contentPadding int
	err := row.Scan(&item.ID, &item.Name, &item.Message, &item.ScheduleType, &targetTime, &item.DaysOfWeek,
		&item.OneTimeAt, &item.Timezone, &item.LeadTimeSeconds, &item.CompletionText, &item.ShowConfetti,
		&item.DisplayMode, &item.HeightPX, &item.ProgressFill, &contentPadding, &item.TextScale,
		&item.UrgencyEnabled, &item.StartingSoonSeconds, &item.UrgentSeconds, &item.PulseSeconds,
		&item.Enabled, &item.Priority, &item.TargetScope, &item.CreatedAt, &item.UpdatedAt)
	item.ContentPadding = &contentPadding
	item.TargetTime = trimTargetTime(targetTime)
	return item, err
}

// Postgres renders `time` as HH:MM:SS. Both the API and the Player manifest
// publish the HH:MM shape the dashboard and validator expect.
func trimTargetTime(value *string) *string {
	if value == nil || *value == "" {
		return value
	}
	trimmed := strings.TrimSuffix(strings.TrimSuffix(*value, "00"), ":")
	return &trimmed
}

func (s *Service) targetIDs(ctx context.Context, id uuid.UUID) ([]uuid.UUID, error) {
	return s.targetIDsFrom(ctx, "countdown_bar_targets", id)
}

// targetIDsFrom reads one instance's targets. `table` is always a literal from
// this package, never request input.
func (s *Service) targetIDsFrom(ctx context.Context, table string, id uuid.UUID) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `SELECT target_id FROM `+table+` WHERE instance_id=$1 ORDER BY target_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []uuid.UUID{}
	for rows.Next() {
		var target uuid.UUID
		if err = rows.Scan(&target); err != nil {
			return nil, err
		}
		ids = append(ids, target)
	}
	return ids, rows.Err()
}

// targetScopeFilter returns the shared screen-target predicate. Both table
// names are package-controlled literals, never request input.
func targetScopeFilter(instancesTable, targetsTable string) string {
	return fmt.Sprintf(`FROM %s i
		WHERE i.enabled AND (
			i.target_scope='all'
			OR (i.target_scope='screens' AND EXISTS(
				SELECT 1 FROM %s t WHERE t.instance_id=i.id AND t.target_type='screens' AND t.target_id=$1))
			OR (i.target_scope='locations' AND EXISTS(
				SELECT 1 FROM %s t JOIN screens sc ON sc.id=$1 AND sc.location_id=t.target_id
				WHERE t.instance_id=i.id AND t.target_type='locations'))
			OR (i.target_scope='sync_groups' AND EXISTS(
				SELECT 1 FROM %s t JOIN screen_group_memberships m ON m.screen_id=$1 AND m.screen_group_id=t.target_id
				WHERE t.instance_id=i.id AND t.target_type='sync_groups'))
		)`, instancesTable, targetsTable, targetsTable, targetsTable)
}

// Omitted values keep the original appearance, while a pointer lets zero
// contentPadding remain an intentional full-width choice.
func normalizeCountdownBar(input CountdownBarInput) CountdownBarInput {
	if strings.TrimSpace(input.ProgressFill) == "" {
		input.ProgressFill = "none"
	}
	if input.ContentPadding == nil {
		defaultPadding := 4
		input.ContentPadding = &defaultPadding
	}
	// Zero is a meaningful contentPadding, so only textScale can treat 0 as
	// "omitted"; a zero scale would render nothing.
	if input.TextScale == 0 {
		input.TextScale = 100
	}
	if input.StartingSoonSeconds == 0 {
		input.StartingSoonSeconds = 300
	}
	if input.UrgentSeconds == 0 {
		input.UrgentSeconds = 60
	}
	if input.PulseSeconds == 0 {
		input.PulseSeconds = 10
	}
	return input
}

func (s *Service) CreateCountdownBar(ctx context.Context, userID uuid.UUID, input CountdownBarInput) (CountdownBar, error) {
	input = normalizeCountdownBar(input)
	if err := validateCountdownBar(input); err != nil {
		return CountdownBar{}, err
	}
	var organizationID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&organizationID); err != nil {
		return CountdownBar{}, err
	}
	id := uuid.New()
	if err := s.writeCountdownBar(ctx, id, organizationID, userID, input, true); err != nil {
		return CountdownBar{}, err
	}
	return s.GetCountdownBar(ctx, id)
}

func (s *Service) UpdateCountdownBar(ctx context.Context, id, userID uuid.UUID, input CountdownBarInput) (CountdownBar, error) {
	input = normalizeCountdownBar(input)
	if err := validateCountdownBar(input); err != nil {
		return CountdownBar{}, err
	}
	if err := s.writeCountdownBar(ctx, id, uuid.Nil, userID, input, false); err != nil {
		return CountdownBar{}, err
	}
	return s.GetCountdownBar(ctx, id)
}

func (s *Service) writeCountdownBar(ctx context.Context, id, organizationID, userID uuid.UUID, input CountdownBarInput, create bool) error {
	if input.DaysOfWeek == nil {
		input.DaysOfWeek = []int{}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = LockInstallation(ctx, tx, CountdownBarID); err != nil {
		return err
	}
	if err = validateTargets(ctx, tx, input.TargetScope, input.TargetIDs); err != nil {
		return err
	}
	var targetTime any
	if input.TargetTime != nil {
		targetTime = *input.TargetTime
	}
	if create {
		_, err = tx.Exec(ctx, `INSERT INTO countdown_bar_instances
			(id,organization_id,name,message,schedule_type,target_time,days_of_week,one_time_at,timezone,lead_time_seconds,
			 completion_text,show_confetti,display_mode,height_px,progress_fill,content_padding,text_scale,
			 urgency_enabled,starting_soon_seconds,urgent_seconds,pulse_seconds,enabled,priority,target_scope,created_by)
			VALUES($1,$2,$3,$4,$5,$6::time,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
			id, organizationID, strings.TrimSpace(input.Name), strings.TrimSpace(input.Message), input.ScheduleType,
			targetTime, input.DaysOfWeek, input.OneTimeAt, input.Timezone, input.LeadTimeSeconds,
			strings.TrimSpace(input.CompletionText), input.ShowConfetti, input.DisplayMode, input.HeightPX, input.ProgressFill, *input.ContentPadding, input.TextScale,
			input.UrgencyEnabled, input.StartingSoonSeconds, input.UrgentSeconds, input.PulseSeconds, input.Enabled, input.Priority, input.TargetScope, userID)
	} else {
		tag, updateErr := tx.Exec(ctx, `UPDATE countdown_bar_instances SET name=$2,message=$3,schedule_type=$4,target_time=$5::time,
			days_of_week=$6,one_time_at=$7,timezone=$8,lead_time_seconds=$9,completion_text=$10,show_confetti=$11,display_mode=$12,height_px=$13,
			progress_fill=$14,content_padding=$15,text_scale=$16,urgency_enabled=$17,starting_soon_seconds=$18,
			urgent_seconds=$19,pulse_seconds=$20,enabled=$21,priority=$22,target_scope=$23,updated_at=now() WHERE id=$1`,
			id, strings.TrimSpace(input.Name), strings.TrimSpace(input.Message), input.ScheduleType, targetTime,
			input.DaysOfWeek, input.OneTimeAt, input.Timezone, input.LeadTimeSeconds, strings.TrimSpace(input.CompletionText),
			input.ShowConfetti, input.DisplayMode, input.HeightPX, input.ProgressFill, *input.ContentPadding, input.TextScale,
			input.UrgencyEnabled, input.StartingSoonSeconds, input.UrgentSeconds, input.PulseSeconds, input.Enabled, input.Priority, input.TargetScope)
		err = updateErr
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM countdown_bar_targets WHERE instance_id=$1`, id); err != nil {
		return err
	}
	for _, targetID := range input.TargetIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO countdown_bar_targets(instance_id,target_type,target_id) VALUES($1,$2,$3)`, id, input.TargetScope, targetID); err != nil {
			return err
		}
	}
	action := "plugin.countdown_bar.updated"
	if create {
		action = "plugin.countdown_bar.created"
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,$3,'plugin', $4)`, uuid.New(), userID, action, id.String()); err != nil {
		return err
	}
	notes, err := s.bumpPlugin(ctx, tx, "countdown_bar", id, "plugin.countdown_bar.changed")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

func (s *Service) DeleteCountdownBar(ctx context.Context, id, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM countdown_bar_instances WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'plugin.countdown_bar.deleted','plugin',$3)`, uuid.New(), userID, id.String()); err != nil {
		return err
	}
	notes, err := s.bumpPlugin(ctx, tx, "countdown_bar", id, "plugin.countdown_bar.deleted")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

func validateCountdownBar(input CountdownBarInput) error {
	if len(strings.TrimSpace(input.Name)) < 1 || len(strings.TrimSpace(input.Name)) > 180 ||
		len(strings.TrimSpace(input.Message)) < 1 || len(strings.TrimSpace(input.Message)) > 280 ||
		len(strings.TrimSpace(input.CompletionText)) > 280 {
		return fmt.Errorf("%w: name, message, or completion text is outside its allowed length", ErrInvalid)
	}
	if _, err := time.LoadLocation(input.Timezone); err != nil {
		return fmt.Errorf("%w: timezone is not a valid IANA timezone", ErrInvalid)
	}
	if input.LeadTimeSeconds < 60 || input.LeadTimeSeconds > 2592000 ||
		input.HeightPX < 40 || input.HeightPX > 320 || input.Priority < -1000 || input.Priority > 1000 {
		return fmt.Errorf("%w: timing, height, or priority is outside its allowed range", ErrInvalid)
	}
	if input.DisplayMode != "overlay" && input.DisplayMode != "push" {
		return fmt.Errorf("%w: displayMode must be overlay or push", ErrInvalid)
	}
	if input.ProgressFill != "none" && input.ProgressFill != "drain" {
		return fmt.Errorf("%w: progressFill must be none or drain", ErrInvalid)
	}
	if input.ContentPadding == nil || *input.ContentPadding < 0 || *input.ContentPadding > 40 {
		return fmt.Errorf("%w: contentPadding must be between 0 and 40 percent", ErrInvalid)
	}
	if input.TextScale < 25 || input.TextScale > 500 {
		return fmt.Errorf("%w: textScale must be between 25 and 500 percent", ErrInvalid)
	}
	if input.StartingSoonSeconds < 2 || input.StartingSoonSeconds > 86400 ||
		input.UrgentSeconds < 2 || input.UrgentSeconds > 3600 || input.PulseSeconds < 1 || input.PulseSeconds > 60 ||
		input.StartingSoonSeconds <= input.UrgentSeconds || input.UrgentSeconds <= input.PulseSeconds {
		return fmt.Errorf("%w: urgency thresholds must be ordered starting soon, urgent, then pulse", ErrInvalid)
	}
	if input.ScheduleType == "weekly" {
		if input.TargetTime == nil || input.OneTimeAt != nil || len(input.DaysOfWeek) == 0 {
			return fmt.Errorf("%w: weekly schedules require a target time and at least one day", ErrInvalid)
		}
		if _, err := time.Parse("15:04", *input.TargetTime); err != nil {
			return fmt.Errorf("%w: targetTime must use HH:MM", ErrInvalid)
		}
		seen := map[int]bool{}
		for _, day := range input.DaysOfWeek {
			if day < 0 || day > 6 || seen[day] {
				return fmt.Errorf("%w: daysOfWeek must contain unique values from 0 through 6", ErrInvalid)
			}
			seen[day] = true
		}
	} else if input.ScheduleType == "one_time" {
		if input.OneTimeAt == nil || input.TargetTime != nil || len(input.DaysOfWeek) != 0 {
			return fmt.Errorf("%w: one-time schedules require oneTimeAt only", ErrInvalid)
		}
	} else {
		return fmt.Errorf("%w: scheduleType must be weekly or one_time", ErrInvalid)
	}
	return validateTargeting(input.TargetScope, input.TargetIDs)
}

// validateTargeting is shared by every plugin: the four scopes and their bounds
// are a property of Tilecast targeting, not of any one plugin.
func validateTargeting(scope string, ids []uuid.UUID) error {
	if scope == "all" {
		if len(ids) != 0 {
			return fmt.Errorf("%w: all-screen targeting cannot include targetIds", ErrInvalid)
		}
	} else if scope != "screens" && scope != "sync_groups" && scope != "locations" {
		return fmt.Errorf("%w: targetScope is invalid", ErrInvalid)
	} else if len(ids) == 0 || len(ids) > 250 {
		return fmt.Errorf("%w: targeted instances require between one and 250 targets", ErrInvalid)
	}
	seenTarget := map[uuid.UUID]bool{}
	for _, target := range ids {
		if seenTarget[target] {
			return fmt.Errorf("%w: targetIds must be unique", ErrInvalid)
		}
		seenTarget[target] = true
	}
	return nil
}

func validateTargets(ctx context.Context, tx pgx.Tx, scope string, ids []uuid.UUID) error {
	if scope == "all" {
		return nil
	}
	table := map[string]string{"screens": "screens", "sync_groups": "screen_groups", "locations": "locations"}[scope]
	var count int
	query := `SELECT count(*) FROM ` + table + ` WHERE id=ANY($1)`
	if table == "screens" {
		query += ` AND archived_at IS NULL`
	} else if table == "screen_groups" {
		query += ` AND deleted_at IS NULL`
	}
	if err := tx.QueryRow(ctx, query, ids).Scan(&count); err != nil {
		return err
	}
	if count != len(ids) {
		return fmt.Errorf("%w: one or more targets do not exist", ErrInvalid)
	}
	return nil
}

type note struct {
	id      uuid.UUID
	version int64
}

func bumpAllScreens(ctx context.Context, tx pgx.Tx, reason string) ([]note, error) {
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason)
		SELECT id,1,$1 FROM screens WHERE archived_at IS NULL
		ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,
		manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$1
		RETURNING screen_id,manifest_version`, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notes := []note{}
	for rows.Next() {
		var n note
		if err = rows.Scan(&n.id, &n.version); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

func (s *Service) notify(notes []note) {
	if s.notifier == nil {
		return
	}
	for _, n := range notes {
		s.notifier.ManifestChanged(n.id, n.version)
	}
}

func (s *Service) bumpPlugin(ctx context.Context, tx pgx.Tx, pluginType string, pluginID uuid.UUID, reason string) ([]note, error) {
	if s.invalidator == nil {
		return bumpAllScreens(ctx, tx, reason)
	}
	notes := []note{}
	err := s.invalidator.InvalidatePluginInTx(ctx, tx, pluginType, pluginID, reason, func(id uuid.UUID, version int64) {
		notes = append(notes, note{id: id, version: version})
	})
	return notes, err
}

// ManifestForScreen projects every enabled instance of every installed built-in
// plugin that applies to one screen, in a stable order. Installation is checked
// first: configuration left behind for a plugin that is not installed — after a
// restore, a downgrade, or a manual edit — never reaches a Player. Bars from
// different plugins travel in one array and carry their own priority, so the
// player decides what occupies the bar from the manifest alone rather than from
// the order the server happened to query in.
func (s *Service) ManifestForScreen(ctx context.Context, screenID uuid.UUID) ([]ManifestPlugin, error) {
	installed, _, err := s.installations(ctx)
	if err != nil {
		return nil, err
	}
	legacy := map[string]func(context.Context, uuid.UUID) ([]ManifestPlugin, error){
		CountdownBarID:    s.countdownBarsForScreen,
		EmergencyAlertsID: s.alertTickersForScreen,
		BrandBugID:        s.brandBugsForScreen,
		NoiseMeterID:      s.noiseMetersForScreen,
	}
	out := []ManifestPlugin{}
	for _, hosted := range s.hosted {
		id := hosted.manifest.ID
		if !installed[id] {
			continue
		}
		var items []ManifestPlugin
		if projector, ok := hosted.plugin.(plugin.ManifestProjector); ok {
			items, err = projector.ProjectManifest(ctx, screenID)
			if err == nil {
				err = checkManifestTypes(hosted.manifest, items)
			}
		} else if project, ok := legacy[id]; ok {
			items, err = project(ctx, screenID)
		}
		if err != nil {
			return nil, err
		}
		out = append(out, items...)
	}
	return out, nil
}

// checkManifestTypes keeps a projector to the entry types its manifest
// declares, so a Player's renderer registry and the server always agree on
// which plugin a manifest entry belongs to.
func checkManifestTypes(manifest plugin.Manifest, items []ManifestPlugin) error {
	declared := map[string]bool{}
	for _, kind := range manifest.ManifestTypes() {
		declared[kind] = true
	}
	for _, item := range items {
		if !declared[item.Type] || item.Version < 1 {
			return fmt.Errorf("plugin %s projected undeclared manifest entry type %q version %d", manifest.ID, item.Type, item.Version)
		}
	}
	return nil
}

// alertTickersForScreen projects live Emergency Alerts activations whose rule
// answers with a bar instead of a Takeover. The message is composed in SQL from
// the activation the poller already stored, so the ticker needs no managed Data
// Source, Widget, or playlist — the three resources a fullscreen response has to
// keep in step with the alert.
func (s *Service) alertTickersForScreen(ctx context.Context, screenID uuid.UUID) ([]ManifestPlugin, error) {
	// One bar per rule: two alerts matching the same rule would otherwise stack
	// two bars from one configured response. The most severe, then the
	// longest-running, is the one that stays.
	rows, err := s.db.Query(ctx, `SELECT DISTINCT ON (a.rule_id) a.rule_id,r.name,
		left(COALESCE(NULLIF(concat_ws(' — ',NULLIF(a.event,''),NULLIF(a.headline,''),NULLIF(a.area_description,''),NULLIF(a.instruction,'')),''),'Active NWS weather alert'),1000),
		a.severity,a.event,r.ticker_display_mode,r.ticker_height_px,r.ticker_speed,a.expires_at
		FROM alert_activations a JOIN alert_rules r ON r.id=a.rule_id
		WHERE a.cleared_at IS NULL AND r.enabled AND r.response_mode='ticker'
			AND a.expires_at IS NOT NULL AND a.expires_at>now()
			AND EXISTS(SELECT 1 FROM alert_rule_targets t WHERE t.rule_id=r.id AND (
				t.screen_id=$1
				OR EXISTS(SELECT 1 FROM screen_group_memberships m WHERE m.screen_group_id=t.screen_group_id AND m.screen_id=$1)))
		ORDER BY a.rule_id,
			CASE a.severity WHEN 'Extreme' THEN 4 WHEN 'Severe' THEN 3 WHEN 'Moderate' THEN 2 WHEN 'Minor' THEN 1 ELSE 0 END DESC,
			a.first_seen_at`, screenID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ManifestPlugin{}
	for rows.Next() {
		var id uuid.UUID
		config := ManifestAlertTickerConfig{Priority: alertTickerPriority}
		if err = rows.Scan(&id, &config.Name, &config.Message, &config.Severity, &config.Event,
			&config.DisplayMode, &config.HeightPX, &config.Speed, &config.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, ManifestPlugin{ID: id, Type: "alert_ticker", Version: 1, Config: config})
	}
	return out, rows.Err()
}

func (s *Service) countdownBarsForScreen(ctx context.Context, screenID uuid.UUID) ([]ManifestPlugin, error) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT i.id,i.name,i.message,i.schedule_type,i.target_time::text,i.days_of_week,
		i.one_time_at,i.timezone,i.lead_time_seconds,i.completion_text,i.show_confetti,i.display_mode,i.height_px,i.progress_fill,i.content_padding,i.text_scale,
		i.urgency_enabled,i.starting_soon_seconds,i.urgent_seconds,i.pulse_seconds,i.priority
		`+targetScopeFilter("countdown_bar_instances", "countdown_bar_targets")+`
		ORDER BY i.priority DESC,i.id`, screenID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ManifestPlugin{}
	for rows.Next() {
		var id uuid.UUID
		var config ManifestCountdownConfig
		if err = rows.Scan(&id, &config.Name, &config.Message, &config.ScheduleType, &config.TargetTime,
			&config.DaysOfWeek, &config.OneTimeAt, &config.Timezone, &config.LeadTimeSeconds,
			&config.CompletionText, &config.ShowConfetti, &config.DisplayMode, &config.HeightPX, &config.ProgressFill, &config.ContentPadding, &config.TextScale,
			&config.UrgencyEnabled, &config.StartingSoonSeconds, &config.UrgentSeconds, &config.PulseSeconds, &config.Priority); err != nil {
			return nil, err
		}
		config.TargetTime = trimTargetTime(config.TargetTime)
		out = append(out, ManifestPlugin{ID: id, Type: "countdown_bar", Version: 1, Config: config})
	}
	return out, rows.Err()
}
