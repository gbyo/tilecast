package settings

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/regional"
)

var ErrRevisionConflict = errors.New("settings revision conflict")

type Notifier interface{ ConfigChanged(uuid.UUID, int64) }
type ManifestNotifier interface{ ManifestChanged(uuid.UUID, int64) }
type HardLimits struct {
	MaxUploadBytes                                         int64
	MaxTakeoverMinutes, MaxWebsiteTimeout, MaxPrefetchDays int
	PrivateHTTPAllowed                                     bool
}
type Service struct {
	db       *pgxpool.Pool
	notifier Notifier
	limits   HardLimits
}
type Document struct {
	SchemaVersion int            `json:"schemaVersion"`
	Revision      int64          `json:"revision"`
	Values        map[string]any `json:"values"`
	Definitions   []Definition   `json:"definitions,omitempty"`
	UpdatedAt     time.Time      `json:"updatedAt"`
}
type PolicyDocument struct {
	SchemaVersion int            `json:"schemaVersion"`
	Revision      int64          `json:"revision"`
	Priority      int            `json:"priority,omitempty"`
	Values        map[string]any `json:"values"`
	UpdatedAt     time.Time      `json:"updatedAt"`
}
type EffectiveValue struct {
	Value    any        `json:"value"`
	Source   string     `json:"source"`
	SourceID *uuid.UUID `json:"sourceId,omitempty"`
}
type EffectivePolicy struct {
	Values               map[string]EffectiveValue `json:"values"`
	OrganizationRevision int64                     `json:"organizationRevision"`
	GroupRevisions       map[string]int64          `json:"groupRevisions"`
	ScreenRevision       int64                     `json:"screenRevision"`
	ConfigRevision       int64                     `json:"configRevision"`
	Hash                 string                    `json:"hash"`
}
type PlayerConfig struct {
	SchemaVersion  int            `json:"schemaVersion"`
	ConfigRevision int64          `json:"configRevision"`
	GeneratedAt    time.Time      `json:"generatedAt"`
	Branding       map[string]any `json:"branding"`
	Playback       map[string]any `json:"playback"`
	Cache          map[string]any `json:"cache"`
	Sync           map[string]any `json:"sync"`
	Website        map[string]any `json:"website"`
	Reliability    map[string]any `json:"reliability"`
	Power          map[string]any `json:"power"`
	ManagedKiosk   map[string]any `json:"managedKiosk"`
	LinuxKiosk     map[string]any `json:"linuxKiosk"`
	Accessibility  map[string]any `json:"accessibility"`
	Updates        map[string]any `json:"updates"`
	// PresentationNetwork is the Linux Presentation Network assignment, filled in
	// by the request layer because the records live in their own domain package.
	// It carries safe identifiers and a configuration revision only: the Wi-Fi
	// credential is never part of a configuration document, which is cached on
	// disk by every player that reads it.
	PresentationNetwork map[string]any `json:"presentationNetwork,omitempty"`
}

// RegionalFormatting is the organization-owned formatting policy consumed by
// signage renderers. It is nested inside the extensible player-config-v1
// playback section so older Players can ignore it safely.
type RegionalFormatting struct {
	Locale         string `json:"locale"`
	Timezone       string `json:"timezone"`
	DateFormat     string `json:"dateFormat"`
	TimeFormat     string `json:"timeFormat"`
	FirstDayOfWeek string `json:"firstDayOfWeek"`
}

func NewService(db *pgxpool.Pool, notifier Notifier, limits HardLimits) *Service {
	return &Service{db: db, notifier: notifier, limits: limits}
}
func (s *Service) Organization(ctx context.Context) (Document, error) {
	var values []byte
	var d Document
	d.Definitions = Definitions()
	err := s.db.QueryRow(ctx, `SELECT schema_version,revision,settings,updated_at FROM organization_runtime_settings`).Scan(&d.SchemaVersion, &d.Revision, &values, &d.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var org uuid.UUID
		if err = s.db.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
			return d, err
		}
		_, err = s.db.Exec(ctx, `INSERT INTO organization_runtime_settings(organization_id)VALUES($1) ON CONFLICT (organization_id) DO NOTHING`, org)
		if err != nil {
			return d, err
		}
		return s.Organization(ctx)
	}
	if err != nil {
		return d, err
	}
	if err := json.Unmarshal(values, &d.Values); err != nil {
		return d, err
	}
	d.Values = mergeOrganizationDefaults(d.Values)
	var name string
	if err := s.db.QueryRow(ctx, `SELECT organization_name FROM organization_settings`).Scan(&name); err != nil {
		return d, err
	}
	d.Values["organization.name"] = name
	return d, nil
}

// OrganizationValues exposes the validated, default-merged organization
// settings to domain services that use the same authoritative registry.
func mergeOrganizationDefaults(values map[string]any) map[string]any {
	legacyApprovalRequired, _ := values["content.approval_required"].(bool)
	_, reviewPolicyStored := values["content.review_policy"]
	merged := mergeDefaults(values, ScopeOrganization)
	if !reviewPolicyStored && legacyApprovalRequired {
		// content.review_policy was introduced after approval_required. Preserve
		// the operator's existing review guarantee until they explicitly choose
		// a new policy. Defaults must not mask the legacy value during upgrade.
		merged["content.review_policy"] = "everyone"
	}
	return merged
}

func (s *Service) OrganizationValues(ctx context.Context) (map[string]any, error) {
	document, err := s.Organization(ctx)
	if err != nil {
		return nil, err
	}
	return document.Values, nil
}
func (s *Service) UpdateOrganization(ctx context.Context, user uuid.UUID, revision int64, values map[string]any) (Document, error) {
	validated, err := Validate(values, ScopeOrganization)
	if err != nil {
		return Document{}, err
	}
	if err = s.hardLimits(validated); err != nil {
		return Document{}, err
	}
	if err = s.validateBranding(ctx, validated); err != nil {
		return Document{}, err
	}
	encoded, err := json.Marshal(validated)
	if err != nil {
		return Document{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Document{}, err
	}
	defer tx.Rollback(ctx)
	var next int64
	var org uuid.UUID
	err = tx.QueryRow(ctx, `UPDATE organization_runtime_settings SET settings=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=now() WHERE revision=$3 RETURNING revision,organization_id`, string(encoded), user, revision).Scan(&next, &org)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrRevisionConflict
	}
	if err != nil {
		return Document{}, err
	}
	if name, ok := validated["organization.name"].(string); ok && name != "" {
		if _, err = tx.Exec(ctx, `UPDATE organization_settings SET organization_name=$1,updated_at=now() WHERE id=$2`, name, org); err != nil {
			return Document{}, err
		}
	}
	if timezone, ok := validated["organization.timezone"].(string); ok && timezone != "" {
		if _, err = tx.Exec(ctx, `UPDATE organization_settings SET default_timezone=$1,updated_at=now() WHERE id=$2`, timezone, org); err != nil {
			return Document{}, err
		}
	}
	keys := sortedKeys(validated)
	metadata, _ := json.Marshal(map[string]any{"changedKeys": keys, "revision": next, "scope": "organization"})
	_, _ = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)VALUES($1,$2,'settings.organization_changed','organization',$3,$4::jsonb)`, uuid.New(), user, org.String(), string(metadata))
	screens, err := bumpAll(ctx, tx, "organization.settings_changed")
	if err != nil {
		return Document{}, err
	}
	manifestScreens, err := bumpOrganizationManifests(ctx, tx, org, "organization.settings_changed")
	if err != nil {
		return Document{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Document{}, err
	}
	s.notify(screens)
	s.notifyManifests(manifestScreens)
	return s.Organization(ctx)
}
func (s *Service) Preferences(ctx context.Context, user uuid.UUID) (Document, error) {
	var d Document
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT schema_version,revision,preferences,updated_at FROM user_preferences WHERE user_id=$1`, user).Scan(&d.SchemaVersion, &d.Revision, &raw, &d.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = s.db.Exec(ctx, `INSERT INTO user_preferences(user_id)VALUES($1) ON CONFLICT (user_id) DO NOTHING`, user)
		if err != nil {
			return d, err
		}
		return s.Preferences(ctx, user)
	}
	if err != nil {
		return d, err
	}
	_ = json.Unmarshal(raw, &d.Values)
	d.Values = mergeDefaults(d.Values, ScopePreference)
	d.Definitions = filterDefinitions(ScopePreference)
	return d, nil
}
func (s *Service) UpdatePreferences(ctx context.Context, user uuid.UUID, revision int64, values map[string]any) (Document, error) {
	validated, err := Validate(values, ScopePreference)
	if err != nil {
		return Document{}, err
	}
	raw, err := json.Marshal(validated)
	if err != nil {
		return Document{}, err
	}
	tag, err := s.db.Exec(ctx, `UPDATE user_preferences SET preferences=$1::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$2 AND revision=$3`, string(raw), user, revision)
	if err != nil {
		return Document{}, err
	}
	if tag.RowsAffected() == 0 {
		return Document{}, ErrRevisionConflict
	}
	return s.Preferences(ctx, user)
}
func (s *Service) GroupPolicy(ctx context.Context, id uuid.UUID) (PolicyDocument, error) {
	var d PolicyDocument
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT schema_version,revision,priority,policy,updated_at FROM screen_group_player_policies WHERE screen_group_id=$1`, id).Scan(&d.SchemaVersion, &d.Revision, &d.Priority, &raw, &d.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		d = PolicyDocument{SchemaVersion: SchemaVersion, Revision: 0, Values: map[string]any{}}
		return d, nil
	}
	if err := json.Unmarshal(raw, &d.Values); err != nil {
		return d, err
	}
	return d, err
}
func (s *Service) PutGroupPolicy(ctx context.Context, user, id uuid.UUID, revision int64, priority int, values map[string]any) (PolicyDocument, error) {
	if priority < -1000 || priority > 1000 {
		return PolicyDocument{}, errors.New("invalid_setting_value: policy priority")
	}
	validated, err := Validate(values, ScopePolicy)
	if err != nil {
		return PolicyDocument{}, err
	}
	raw, err := json.Marshal(validated)
	if err != nil {
		return PolicyDocument{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PolicyDocument{}, err
	}
	defer tx.Rollback(ctx)
	var next int64
	if revision == 0 {
		err = tx.QueryRow(ctx, `INSERT INTO screen_group_player_policies(screen_group_id,priority,policy,updated_by)VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING RETURNING revision`, id, priority, string(raw), user).Scan(&next)
	} else {
		err = tx.QueryRow(ctx, `UPDATE screen_group_player_policies SET priority=$2,policy=$3::jsonb,revision=revision+1,updated_by=$4,updated_at=now() WHERE screen_group_id=$1 AND revision=$5 RETURNING revision`, id, priority, string(raw), user, revision).Scan(&next)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return PolicyDocument{}, ErrRevisionConflict
	}
	if err != nil {
		return PolicyDocument{}, err
	}
	notes, err := bumpGroup(ctx, tx, id, "group.policy_changed")
	if err != nil {
		return PolicyDocument{}, err
	}
	s.audit(ctx, tx, user, "settings.group_policy_changed", "screen_group", id, validated, next)
	if err = tx.Commit(ctx); err != nil {
		return PolicyDocument{}, err
	}
	s.notify(notes)
	return s.GroupPolicy(ctx, id)
}
func (s *Service) DeleteGroupPolicy(ctx context.Context, user, id uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `DELETE FROM screen_group_player_policies WHERE screen_group_id=$1`, id)
	if err != nil {
		return err
	}
	notes, err := bumpGroup(ctx, tx, id, "group.policy_reset")
	if err != nil {
		return err
	}
	s.audit(ctx, tx, user, "settings.group_policy_reset", "screen_group", id, map[string]any{}, 0)
	if err = tx.Commit(ctx); err == nil {
		s.notify(notes)
	}
	return err
}
func (s *Service) ScreenPolicy(ctx context.Context, id uuid.UUID) (PolicyDocument, error) {
	var d PolicyDocument
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT schema_version,revision,policy,updated_at FROM screen_player_policies WHERE screen_id=$1`, id).Scan(&d.SchemaVersion, &d.Revision, &raw, &d.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return PolicyDocument{SchemaVersion: 1, Values: map[string]any{}}, nil
	}
	if err := json.Unmarshal(raw, &d.Values); err != nil {
		return d, err
	}
	return d, err
}
func (s *Service) PutScreenPolicy(ctx context.Context, user, id uuid.UUID, revision int64, values map[string]any) (PolicyDocument, error) {
	validated, err := Validate(values, ScopePolicy)
	if err != nil {
		return PolicyDocument{}, err
	}
	raw, err := json.Marshal(validated)
	if err != nil {
		return PolicyDocument{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PolicyDocument{}, err
	}
	defer tx.Rollback(ctx)
	if revision == 0 {
		err = tx.QueryRow(ctx, `INSERT INTO screen_player_policies(screen_id,policy,updated_by)VALUES($1,$2::jsonb,$3) ON CONFLICT DO NOTHING RETURNING revision`, id, string(raw), user).Scan(&revision)
	} else {
		err = tx.QueryRow(ctx, `UPDATE screen_player_policies SET policy=$2::jsonb,revision=revision+1,updated_by=$3,updated_at=now() WHERE screen_id=$1 AND revision=$4 RETURNING revision`, id, string(raw), user, revision).Scan(&revision)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return PolicyDocument{}, ErrRevisionConflict
	}
	if err != nil {
		return PolicyDocument{}, err
	}
	notes, err := bumpScreens(ctx, tx, []uuid.UUID{id}, "screen.policy_changed")
	if err != nil {
		return PolicyDocument{}, err
	}
	s.audit(ctx, tx, user, "settings.screen_policy_changed", "screen", id, validated, revision)
	if err = tx.Commit(ctx); err != nil {
		return PolicyDocument{}, err
	}
	s.notify(notes)
	return s.ScreenPolicy(ctx, id)
}
func (s *Service) DeleteScreenPolicy(ctx context.Context, user, id uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `DELETE FROM screen_player_policies WHERE screen_id=$1`, id)
	if err != nil {
		return err
	}
	notes, err := bumpScreens(ctx, tx, []uuid.UUID{id}, "screen.policy_reset")
	if err != nil {
		return err
	}
	s.audit(ctx, tx, user, "settings.screen_policy_reset", "screen", id, map[string]any{}, 0)
	if err = tx.Commit(ctx); err == nil {
		s.notify(notes)
	}
	return err
}

func (s *Service) Effective(ctx context.Context, screen uuid.UUID) (EffectivePolicy, error) {
	org, err := s.Organization(ctx)
	if err != nil {
		return EffectivePolicy{}, err
	}
	result := EffectivePolicy{Values: map[string]EffectiveValue{}, OrganizationRevision: org.Revision, GroupRevisions: map[string]int64{}}
	for _, d := range definitions {
		if d.Scope == ScopePolicy {
			value := d.Default
			if v, ok := org.Values[d.Key]; ok {
				value = v
			}
			result.Values[d.Key] = EffectiveValue{Value: value, Source: "Organization default"}
		}
	}
	rows, err := s.db.Query(ctx, `SELECT g.id,g.name,p.revision,p.policy FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id JOIN screen_group_player_policies p ON p.screen_group_id=g.id WHERE m.screen_id=$1 AND g.deleted_at IS NULL ORDER BY p.priority DESC,g.id ASC`, screen)
	if err != nil {
		return result, err
	}
	claimed := map[string]bool{}
	for rows.Next() {
		var id uuid.UUID
		var name string
		var revision int64
		var raw []byte
		if err := rows.Scan(&id, &name, &revision, &raw); err != nil {
			rows.Close()
			return result, err
		}
		result.GroupRevisions[id.String()] = revision
		var values map[string]any
		if err := json.Unmarshal(raw, &values); err != nil {
			rows.Close()
			return result, err
		}
		for key, value := range values {
			if !claimed[key] {
				copyID := id
				result.Values[key] = EffectiveValue{Value: value, Source: name, SourceID: &copyID}
				claimed[key] = true
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return result, err
	}
	rows.Close()
	screenPolicy, err := s.ScreenPolicy(ctx, screen)
	if err != nil {
		return result, err
	}
	result.ScreenRevision = screenPolicy.Revision
	for key, value := range screenPolicy.Values {
		copyID := screen
		result.Values[key] = EffectiveValue{Value: value, Source: "This screen", SourceID: &copyID}
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO screen_config_state(screen_id)VALUES($1)ON CONFLICT DO NOTHING`, screen); err != nil {
		return result, err
	}
	if err := s.db.QueryRow(ctx, `SELECT config_revision FROM screen_config_state WHERE screen_id=$1`, screen).Scan(&result.ConfigRevision); err != nil {
		return result, err
	}
	encoded, err := json.Marshal(result.Values)
	if err != nil {
		return result, err
	}
	maxCache, _ := result.Values["player.cache.max_bytes"].Value.(float64)
	minimumFree, _ := result.Values["player.cache.minimum_free_bytes"].Value.(float64)
	if minimumFree > maxCache {
		return result, errors.New("policy_conflict: minimum free storage exceeds cache maximum")
	}
	sum := sha256.Sum256(encoded)
	result.Hash = hex.EncodeToString(sum[:])
	return result, nil
}
func (s *Service) PlayerConfiguration(ctx context.Context, screen uuid.UUID) (PlayerConfig, string, error) {
	effective, err := s.Effective(ctx, screen)
	if err != nil {
		return PlayerConfig{}, "", err
	}
	org, err := s.Organization(ctx)
	if err != nil {
		return PlayerConfig{}, "", err
	}
	var name string
	if err := s.db.QueryRow(ctx, `SELECT organization_name FROM organization_settings`).Scan(&name); err != nil {
		return PlayerConfig{}, "", err
	}
	var screenLocation string
	if err := s.db.QueryRow(ctx, `SELECT concat_ws(' · ',NULLIF(l.name,''),NULLIF(s.room_name,''),NULLIF(s.room_number,'')) FROM screens s LEFT JOIN locations l ON l.id=s.location_id WHERE s.id=$1`, screen).Scan(&screenLocation); err != nil {
		return PlayerConfig{}, "", err
	}
	v := func(key string) any { return effective.Values[key].Value }
	o := func(key string) any { return org.Values[key] }
	config := PlayerConfig{SchemaVersion: 1, ConfigRevision: effective.ConfigRevision, GeneratedAt: time.Now().UTC(), Branding: map[string]any{"organizationName": name, "logoAssetId": o("branding.logo_asset_id"), "backgroundColor": o("branding.player_background_color"), "textColor": o("branding.player_text_color"), "noContentTitle": o("branding.no_content_title"), "noContentMessage": o("branding.no_content_message"), "disabledTitle": o("branding.disabled_title"), "disabledMessage": o("branding.disabled_message"), "footerText": o("branding.footer_text")}, Playback: map[string]any{"defaultVolume": v("player.playback.default_volume"), "defaultFitMode": v("player.playback.default_fit_mode"), "defaultImageDurationSeconds": v("player.playback.default_image_duration_seconds"), "defaultTransition": v("player.playback.default_transition"), "defaultAudioEnabled": v("player.playback.default_audio_enabled"), "resumeAfterRestart": v("player.playback.resume_after_restart"), "identifyShowsLocation": v("player.identify.show_location"), "screenLocation": screenLocation, "regionalFormat": regionalFormatting(org.Values)}, Cache: map[string]any{"maximumBytes": v("player.cache.max_bytes"), "minimumFreeBytes": v("player.cache.minimum_free_bytes"), "concurrentDownloads": v("player.download.concurrent_limit"), "automaticThresholdBytes": v("player.download.automatic_threshold_bytes")}, Sync: map[string]any{"manifestReconciliationSeconds": v("player.sync.manifest_seconds"), "statusReportSeconds": v("player.sync.status_seconds")},
		Reliability:   map[string]any{"mode": v("reliability.mode"), "launchAfterBoot": v("reliability.launch_after_boot"), "immersiveMode": v("reliability.immersive_mode"), "foregroundWatchdogEnabled": v("reliability.foreground_watchdog_enabled"), "playbackStallSeconds": v("reliability.playback_stall_seconds"), "webviewStallSeconds": v("reliability.webview_stall_seconds"), "maximumProcessRestarts": v("reliability.maximum_process_restarts"), "restartWindowMinutes": v("reliability.restart_window_minutes"), "safeModeEnabled": v("reliability.safe_mode_enabled")},
		Website:       map[string]any{"timeoutSeconds": v("player.website.timeout_seconds"), "cookiePolicy": v("player.website.cookie_policy"), "clearOnRestart": v("player.website.clear_on_restart"), "defaultJavascript": o("website.default_javascript"), "defaultDomStorage": o("website.default_dom_storage"), "defaultTimeoutSeconds": o("website.default_timeout_seconds"), "defaultCookiePolicy": o("website.default_cookie_policy"), "defaultReloadPolicy": o("website.default_reload_policy"), "minimumRefreshSeconds": o("website.minimum_refresh_seconds"), "defaultFailureBehavior": o("website.default_failure_behavior"), "defaultZoomPercent": o("website.default_zoom_percent"), "defaultFallbackImageId": o("website.default_fallback_image_id")},
		Power:         map[string]any{"activeHoursEnabled": v("power.active_hours_enabled"), "activeHoursTimezone": v("power.active_hours_timezone"), "activeHoursDays": v("power.active_hours_days"), "activeHoursStart": v("power.active_hours_start"), "activeHoursEnd": v("power.active_hours_end"), "startupGraceSeconds": v("power.startup_grace_seconds"), "shutdownPrepareSeconds": v("power.shutdown_prepare_seconds"), "keepScreenOn": v("power.keep_screen_on"), "sleepOutsideActiveHours": v("power.sleep_outside_active_hours"), "outsideActiveHoursDisplay": v("power.outside_active_hours_display"), "outsideActiveHoursText": v("power.outside_active_hours_text"), "blackScreenFallback": v("power.outside_active_hours_display") == "black"},
		ManagedKiosk:  map[string]any{"lockTaskEnabled": v("managed_kiosk.lock_task_enabled"), "blockOverlays": v("managed_kiosk.block_overlays"), "allowSettingsDuringAdmin": v("managed_kiosk.allow_settings_during_admin"), "adminSessionMinutes": v("managed_kiosk.admin_session_minutes")},
		LinuxKiosk:    map[string]any{"fullscreenEnabled": v("linux_kiosk.fullscreen_enabled"), "preventDisplaySleep": v("linux_kiosk.prevent_display_sleep")},
		Accessibility: map[string]any{"controlAssistEnabled": v("accessibility.control_assist_enabled"), "returnDelaySeconds": v("accessibility.return_delay_seconds"), "allowedPackages": v("accessibility.allowed_packages"), "pauseDuringUpdates": v("accessibility.pause_during_updates"), "pauseDuringAdminSession": v("accessibility.pause_during_admin_session"), "reportForegroundPackage": v("accessibility.report_foreground_package"), "maximumReturns": v("accessibility.maximum_returns"), "returnWindowMinutes": v("accessibility.return_window_minutes")},
		Updates:       map[string]any{"channel": v("player.update.channel")}}
	return config, fmt.Sprintf(`"config-%s-%d"`, screen, effective.ConfigRevision), nil
}

func regionalFormatting(values map[string]any) RegionalFormatting {
	stringValue := func(key, fallback string) string {
		value, ok := values[key].(string)
		if !ok || value == "" {
			return fallback
		}
		return value
	}
	locale, err := regional.CanonicalLocale(stringValue("organization.locale", "en-US"))
	if err != nil {
		// This fallback preserves player-config v1's original default for a
		// legacy or unreadable stored value. It is not derived from the device.
		locale = "en-US"
	}
	firstDay := stringValue("organization.first_day_of_week", "locale")
	if firstDay == "locale" {
		firstDay = regional.FirstDayOfWeek(locale)
	}
	if !isWeekday(firstDay) {
		firstDay = "sunday"
	}
	return RegionalFormatting{
		Locale:         locale,
		Timezone:       stringValue("organization.timezone", "UTC"),
		DateFormat:     stringValue("organization.date_format", "locale"),
		TimeFormat:     stringValue("organization.time_format", "locale"),
		FirstDayOfWeek: firstDay,
	}
}

func isWeekday(value string) bool {
	switch value {
	case "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday":
		return true
	default:
		return false
	}
}

// BumpScreens advances the configuration revision for a set of screens and
// notifies them, for features whose own tables are the source of a
// player-visible configuration change.
//
// A Presentation Network assignment is the case this exists for. The desired
// state a player must converge on — which network it should have provisioned, or
// that it should have none — belongs in durable configuration rather than in a
// command, because a command expires and an offline player would then keep an
// obsolete Tilecast-managed Wi-Fi profile indefinitely.
func (s *Service) BumpScreens(ctx context.Context, screens []uuid.UUID, reason string) error {
	if len(screens) == 0 {
		return nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	notes, err := bumpScreens(ctx, tx, screens, reason)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

type note struct {
	id       uuid.UUID
	revision int64
}

func bumpAll(ctx context.Context, tx pgx.Tx, reason string) ([]note, error) {
	rows, err := tx.Query(ctx, `UPDATE screen_config_state SET config_revision=config_revision+1,changed_at=now(),change_reason=$1 RETURNING screen_id,config_revision`, reason)
	return scanNotes(rows, err)
}
func bumpGroup(ctx context.Context, tx pgx.Tx, group uuid.UUID, reason string) ([]note, error) {
	rows, err := tx.Query(ctx, `UPDATE screen_config_state SET config_revision=config_revision+1,changed_at=now(),change_reason=$2 WHERE screen_id IN(SELECT screen_id FROM screen_group_memberships WHERE screen_group_id=$1) RETURNING screen_id,config_revision`, group, reason)
	return scanNotes(rows, err)
}
func bumpScreens(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, reason string) ([]note, error) {
	rows, err := tx.Query(ctx, `UPDATE screen_config_state SET config_revision=config_revision+1,changed_at=now(),change_reason=$2 WHERE screen_id=ANY($1) RETURNING screen_id,config_revision`, ids, reason)
	return scanNotes(rows, err)
}
func scanNotes(rows pgx.Rows, err error) ([]note, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []note{}
	for rows.Next() {
		var n note
		if err = rows.Scan(&n.id, &n.revision); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
func (s *Service) notify(notes []note) {
	if s.notifier != nil {
		for _, n := range notes {
			s.notifier.ConfigChanged(n.id, n.revision)
		}
	}
}

type manifestNote struct {
	id      uuid.UUID
	version int64
}

// Organization branding and fallback policy are part of the player manifest
// even when no playlist names them. Keep the manifest version in the same
// transaction as the settings revision so a conditional request cannot retain
// an old logo or fallback after a successful settings write.
func bumpOrganizationManifests(ctx context.Context, tx pgx.Tx, organization uuid.UUID, reason string) ([]manifestNote, error) {
	if _, err := tx.Exec(ctx, `
		INSERT INTO screen_manifest_state(screen_id)
		SELECT id FROM screens WHERE organization_id=$1
		ON CONFLICT(screen_id) DO NOTHING`, organization); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		UPDATE screen_manifest_state ms
		SET previous_manifest_version=ms.manifest_version,
			manifest_version=ms.manifest_version+1,
			changed_at=now(),change_reason=$2
		FROM screens s
		WHERE s.id=ms.screen_id AND s.organization_id=$1
		RETURNING ms.screen_id,ms.manifest_version`, organization, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []manifestNote{}
	for rows.Next() {
		var item manifestNote
		if err := rows.Scan(&item.id, &item.version); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Service) notifyManifests(notes []manifestNote) {
	notifier, ok := s.notifier.(ManifestNotifier)
	if !ok {
		return
	}
	for _, item := range notes {
		notifier.ManifestChanged(item.id, item.version)
	}
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, user uuid.UUID, action, resource string, id uuid.UUID, values map[string]any, revision int64) {
	metadata, _ := json.Marshal(map[string]any{"changedKeys": sortedKeys(values), "revision": revision, "scope": resource})
	_, _ = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)VALUES($1,$2,$3,$4,$5,$6::jsonb)`, uuid.New(), user, action, resource, id.String(), string(metadata))
}

// mergeDefaults lays the stored values over the registry's defaults, keeping only
// the keys the registry still defines at this scope.
//
// The filter is the point. Stored settings outlive the registry: retiring a
// setting deletes its definition but leaves its value in the JSON document, and
// a document is only rewritten when someone saves. Handing those orphans back
// made the Settings page unsavable — the dashboard posts the document it was
// given, Validate refused the retired key with unknown_setting, and the entire
// save failed, including whichever unrelated setting the operator had come to
// change. Filtering here is also what cleans them up: the next successful save
// writes back the validated set, and the orphan is gone for good.
func mergeDefaults(values map[string]any, scope Scope) map[string]any {
	out := Defaults(scope)
	for key, value := range values {
		definition, ok := byKey[key]
		if !ok || !WritableAtScope(definition, scope) {
			continue
		}
		out[key] = value
	}
	return out
}
func filterDefinitions(scope Scope) []Definition {
	out := []Definition{}
	for _, d := range definitions {
		if d.Scope == scope {
			out = append(out, d)
		}
	}
	return out
}
func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
func (s *Service) hardLimits(v map[string]any) error {
	checks := []struct {
		key string
		max float64
	}{{"media.upload.max_bytes", float64(s.limits.MaxUploadBytes)}, {"takeover.maximum_duration_minutes", float64(s.limits.MaxTakeoverMinutes)}, {"website.default_timeout_seconds", float64(s.limits.MaxWebsiteTimeout)}, {"scheduling.prefetch_days", float64(s.limits.MaxPrefetchDays)}}
	for _, c := range checks {
		if n, ok := v[c.key].(float64); ok && c.max > 0 && n > c.max {
			return fmt.Errorf("setting_exceeds_hard_limit: %s", c.key)
		}
	}
	if enabled, _ := v["website.private_http_enabled"].(bool); enabled && !s.limits.PrivateHTTPAllowed {
		return errors.New("setting_exceeds_hard_limit: private HTTP is disabled at deployment")
	}
	if defaultDuration, ok := v["takeover.default_duration_minutes"].(float64); ok {
		if maximum, ok := v["takeover.maximum_duration_minutes"].(float64); ok && defaultDuration > maximum {
			return errors.New("invalid_setting_value: default takeover duration exceeds maximum")
		}
	}
	return nil
}
func (s *Service) validateBranding(ctx context.Context, v map[string]any) error {
	background, _ := v["branding.player_background_color"].(string)
	textColor, _ := v["branding.player_text_color"].(string)
	if background != "" && textColor != "" && contrast(background, textColor) < 4.5 {
		return errors.New("invalid_setting_value: player text and background colors need at least 4.5:1 contrast")
	}
	for _, key := range []string{"branding.logo_asset_id", "branding.icon_asset_id"} {
		value, _ := v[key].(string)
		if value == "" {
			continue
		}
		id, err := uuid.Parse(value)
		if err != nil {
			return errors.New("branding_asset_invalid")
		}
		var valid bool
		_ = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1 AND type='image' AND processing_status='ready' AND deleted_at IS NULL)`, id).Scan(&valid)
		if !valid {
			return errors.New("branding_asset_invalid")
		}
	}
	return nil
}
func contrast(a, b string) float64 {
	la, lb := luminance(a), luminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + .05) / (lb + .05)
}
func luminance(color string) float64 {
	if len(color) != 7 {
		return 0
	}
	channels := []float64{}
	for i := 1; i < 7; i += 2 {
		value, _ := strconv.ParseUint(color[i:i+2], 16, 8)
		c := float64(value) / 255
		if c <= .03928 {
			c /= 12.92
		} else {
			c = pow((c+.055)/1.055, 2.4)
		}
		channels = append(channels, c)
	}
	return .2126*channels[0] + .7152*channels[1] + .0722*channels[2]
}
func pow(x, y float64) float64 { return math.Pow(x, y) }
