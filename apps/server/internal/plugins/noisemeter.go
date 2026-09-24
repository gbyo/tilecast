package plugins

// Noise Meter: a bottom bar that appears only while the room a screen is in
// stays too loud. The level is measured locally by the Linux Player from its
// own microphone — no audio, no samples, and no recording ever reach Tilecast,
// so this package stores thresholds and targeting and nothing else.
//
// The measurement is hardware-local in a second sense: one physical screen has
// one microphone, so at most one instance can run on it. Overlapping instances
// are resolved here rather than by asking a Player to run two meters at once.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const noiseMeterColumns = `id,name,message,warning_level,loud_level,sensitivity,trigger_hold_ms,clear_hold_ms,
	display_mode,height_px,history_enabled,history_retention_days,history_active_hours_only,
	schedule_enabled,schedule_days_of_week,schedule_start_time::text,schedule_end_time::text,schedule_timezone,
	enabled,target_scope,created_at,updated_at`

// The retention windows an operator may choose. A closed set rather than a free
// integer: the Player prunes its own local queue with the same window, and two
// sides guessing at an arbitrary number is how history quietly disagrees.
var noiseMeterRetentionDays = map[int]bool{1: true, 3: true, 7: true, 14: true, 30: true}

type NoiseMeterInput struct {
	Name    string `json:"name"`
	Message string `json:"message"`
	// WarningLevel and LoudLevel are points on the normalized 0-100 Tilecast
	// noise scale. They are relative to the Player's own microphone and are not
	// decibels of any kind.
	WarningLevel int `json:"warningLevel"`
	LoudLevel    int `json:"loudLevel"`
	// Sensitivity is a percentage applied to the captured signal before it is
	// normalized, so a quiet or hot microphone can be brought into range without
	// exposing gain, dBFS, or a hardware identifier to an operator.
	Sensitivity   int    `json:"sensitivity"`
	TriggerHoldMS int    `json:"triggerHoldMs"`
	ClearHoldMS   int    `json:"clearHoldMs"`
	DisplayMode   string `json:"displayMode"`
	HeightPX      int    `json:"heightPx"`
	// History stores derived ten-second aggregates only. There is no audio in
	// it, and no setting here can put any there.
	HistoryEnabled         bool `json:"historyEnabled"`
	HistoryRetentionDays   int  `json:"historyRetentionDays"`
	HistoryActiveHoursOnly bool `json:"historyActiveHoursOnly"`
	// When the bar may appear. Measurement and display are separate questions:
	// a room can be worth measuring all day while the bar is only wanted during
	// class. An instance with no window may show whenever the room is too loud.
	ScheduleEnabled bool `json:"scheduleEnabled"`
	// Sunday is 0 and Saturday is 6, as everywhere else in Tilecast.
	ScheduleDaysOfWeek []int       `json:"scheduleDaysOfWeek"`
	ScheduleStartTime  *string     `json:"scheduleStartTime,omitempty"`
	ScheduleEndTime    *string     `json:"scheduleEndTime,omitempty"`
	ScheduleTimezone   string      `json:"scheduleTimezone"`
	Enabled            bool        `json:"enabled"`
	TargetScope        string      `json:"targetScope"`
	TargetIDs          []uuid.UUID `json:"targetIds"`
}

type NoiseMeter struct {
	ID uuid.UUID `json:"id"`
	NoiseMeterInput
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ManifestNoiseMeterConfig is the Player-facing projection. It deliberately
// carries no device, input, or channel selector: the Player uses its own default
// system microphone, and a Chromium device ID means nothing on another machine.
type ManifestNoiseMeterConfig struct {
	Name          string `json:"name"`
	Message       string `json:"message,omitempty"`
	WarningLevel  int    `json:"warningLevel"`
	LoudLevel     int    `json:"loudLevel"`
	Sensitivity   int    `json:"sensitivity"`
	TriggerHoldMS int    `json:"triggerHoldMs"`
	ClearHoldMS   int    `json:"clearHoldMs"`
	DisplayMode   string `json:"displayMode"`
	HeightPX      int    `json:"heightPx"`
	// The Player needs all three: whether to aggregate at all, how long to keep
	// unsent buckets locally, and whether to stop measuring outside active hours.
	HistoryEnabled         bool `json:"historyEnabled"`
	HistoryRetentionDays   int  `json:"historyRetentionDays"`
	HistoryActiveHoursOnly bool `json:"historyActiveHoursOnly"`
	// The display window, evaluated locally against the Player's corrected
	// clock so a temporary server outage cannot make the bar appear outside it.
	ScheduleEnabled    bool    `json:"scheduleEnabled"`
	ScheduleDaysOfWeek []int   `json:"scheduleDaysOfWeek,omitempty"`
	ScheduleStartTime  *string `json:"scheduleStartTime,omitempty"`
	ScheduleEndTime    *string `json:"scheduleEndTime,omitempty"`
	ScheduleTimezone   string  `json:"scheduleTimezone,omitempty"`
}

func (s *Service) ListNoiseMeters(ctx context.Context) ([]NoiseMeter, error) {
	rows, err := s.db.Query(ctx, `SELECT `+noiseMeterColumns+` FROM noise_meter_instances
		ORDER BY lower(name),id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []NoiseMeter{}
	for rows.Next() {
		item, scanErr := scanNoiseMeter(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// Targets are read after the instance cursor is drained so the listing needs
	// one pooled connection at a time.
	for index := range items {
		if items[index].TargetIDs, err = s.targetIDsFrom(ctx, "noise_meter_targets", items[index].ID); err != nil {
			return nil, err
		}
	}
	return items, nil
}

func (s *Service) GetNoiseMeter(ctx context.Context, id uuid.UUID) (NoiseMeter, error) {
	row := s.db.QueryRow(ctx, `SELECT `+noiseMeterColumns+` FROM noise_meter_instances WHERE id=$1`, id)
	item, err := scanNoiseMeter(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return NoiseMeter{}, ErrNotFound
	}
	if err != nil {
		return NoiseMeter{}, err
	}
	item.TargetIDs, err = s.targetIDsFrom(ctx, "noise_meter_targets", id)
	return item, err
}

func scanNoiseMeter(row scanner) (NoiseMeter, error) {
	var item NoiseMeter
	err := row.Scan(&item.ID, &item.Name, &item.Message, &item.WarningLevel, &item.LoudLevel,
		&item.Sensitivity, &item.TriggerHoldMS, &item.ClearHoldMS, &item.DisplayMode, &item.HeightPX,
		&item.HistoryEnabled, &item.HistoryRetentionDays, &item.HistoryActiveHoursOnly,
		&item.ScheduleEnabled, &item.ScheduleDaysOfWeek, &item.ScheduleStartTime, &item.ScheduleEndTime,
		&item.ScheduleTimezone,
		&item.Enabled, &item.TargetScope, &item.CreatedAt, &item.UpdatedAt)
	item.ScheduleStartTime = trimTargetTime(item.ScheduleStartTime)
	item.ScheduleEndTime = trimTargetTime(item.ScheduleEndTime)
	return item, err
}

// normalizeNoiseMeter fills in the documented defaults for values a client left
// at zero, so a minimal create body produces the same meter Studio's form does.
func normalizeNoiseMeter(input NoiseMeterInput) NoiseMeterInput {
	if input.WarningLevel == 0 {
		input.WarningLevel = 60
	}
	if input.LoudLevel == 0 {
		input.LoudLevel = 80
	}
	if input.Sensitivity == 0 {
		input.Sensitivity = 100
	}
	if input.TriggerHoldMS == 0 {
		input.TriggerHoldMS = 1000
	}
	if input.ClearHoldMS == 0 {
		input.ClearHoldMS = 3000
	}
	if input.HeightPX == 0 {
		input.HeightPX = 96
	}
	if strings.TrimSpace(input.DisplayMode) == "" {
		input.DisplayMode = "overlay"
	}
	if input.HistoryRetentionDays == 0 {
		input.HistoryRetentionDays = 7
	}
	if strings.TrimSpace(input.ScheduleTimezone) == "" {
		input.ScheduleTimezone = "UTC"
	}
	if input.ScheduleDaysOfWeek == nil {
		input.ScheduleDaysOfWeek = []int{}
	}
	return input
}

func (s *Service) CreateNoiseMeter(ctx context.Context, userID uuid.UUID, input NoiseMeterInput) (NoiseMeter, error) {
	input = normalizeNoiseMeter(input)
	if err := validateNoiseMeter(input); err != nil {
		return NoiseMeter{}, err
	}
	var organizationID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&organizationID); err != nil {
		return NoiseMeter{}, err
	}
	id := uuid.New()
	if err := s.writeNoiseMeter(ctx, id, organizationID, userID, input, true); err != nil {
		return NoiseMeter{}, err
	}
	return s.GetNoiseMeter(ctx, id)
}

func (s *Service) UpdateNoiseMeter(ctx context.Context, id, userID uuid.UUID, input NoiseMeterInput) (NoiseMeter, error) {
	input = normalizeNoiseMeter(input)
	if err := validateNoiseMeter(input); err != nil {
		return NoiseMeter{}, err
	}
	if err := s.writeNoiseMeter(ctx, id, uuid.Nil, userID, input, false); err != nil {
		return NoiseMeter{}, err
	}
	return s.GetNoiseMeter(ctx, id)
}

func (s *Service) writeNoiseMeter(ctx context.Context, id, organizationID, userID uuid.UUID, input NoiseMeterInput, create bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err = LockInstallation(ctx, tx, NoiseMeterID); err != nil {
		return err
	}
	if err = validateTargets(ctx, tx, input.TargetScope, input.TargetIDs); err != nil {
		return err
	}
	name, message := strings.TrimSpace(input.Name), strings.TrimSpace(input.Message)
	if create {
		_, err = tx.Exec(ctx, `INSERT INTO noise_meter_instances
			(id,organization_id,name,message,warning_level,loud_level,sensitivity,trigger_hold_ms,clear_hold_ms,
			 display_mode,height_px,history_enabled,history_retention_days,history_active_hours_only,
			 schedule_enabled,schedule_days_of_week,schedule_start_time,schedule_end_time,schedule_timezone,
			 enabled,target_scope,created_by)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::time,$18::time,$19,$20,$21,$22)`,
			id, organizationID, name, message, input.WarningLevel, input.LoudLevel, input.Sensitivity,
			input.TriggerHoldMS, input.ClearHoldMS, input.DisplayMode, input.HeightPX,
			input.HistoryEnabled, input.HistoryRetentionDays, input.HistoryActiveHoursOnly,
			input.ScheduleEnabled, input.ScheduleDaysOfWeek, scheduleTime(input.ScheduleStartTime),
			scheduleTime(input.ScheduleEndTime), input.ScheduleTimezone,
			input.Enabled, input.TargetScope, userID)
	} else {
		tag, updateErr := tx.Exec(ctx, `UPDATE noise_meter_instances SET name=$2,message=$3,warning_level=$4,
			loud_level=$5,sensitivity=$6,trigger_hold_ms=$7,clear_hold_ms=$8,display_mode=$9,height_px=$10,
			history_enabled=$11,history_retention_days=$12,history_active_hours_only=$13,
			schedule_enabled=$14,schedule_days_of_week=$15,schedule_start_time=$16::time,
			schedule_end_time=$17::time,schedule_timezone=$18,
			enabled=$19,target_scope=$20,updated_at=now() WHERE id=$1`,
			id, name, message, input.WarningLevel, input.LoudLevel, input.Sensitivity,
			input.TriggerHoldMS, input.ClearHoldMS, input.DisplayMode, input.HeightPX,
			input.HistoryEnabled, input.HistoryRetentionDays, input.HistoryActiveHoursOnly,
			input.ScheduleEnabled, input.ScheduleDaysOfWeek, scheduleTime(input.ScheduleStartTime),
			scheduleTime(input.ScheduleEndTime), input.ScheduleTimezone,
			input.Enabled, input.TargetScope)
		err = updateErr
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM noise_meter_targets WHERE instance_id=$1`, id); err != nil {
		return err
	}
	for _, targetID := range input.TargetIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO noise_meter_targets(instance_id,target_type,target_id) VALUES($1,$2,$3)`,
			id, input.TargetScope, targetID); err != nil {
			return err
		}
	}
	action := "plugin.noise_meter.updated"
	if create {
		action = "plugin.noise_meter.created"
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,$3,'plugin',$4)`,
		uuid.New(), userID, action, id.String()); err != nil {
		return err
	}
	notes, err := s.bumpPlugin(ctx, tx, "noise_meter", id, "plugin.noise_meter.changed")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

func (s *Service) DeleteNoiseMeter(ctx context.Context, id, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `DELETE FROM noise_meter_instances WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)
		VALUES($1,$2,'plugin.noise_meter.deleted','plugin',$3)`, uuid.New(), userID, id.String()); err != nil {
		return err
	}
	notes, err := s.bumpPlugin(ctx, tx, "noise_meter", id, "plugin.noise_meter.deleted")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

func validateNoiseMeter(input NoiseMeterInput) error {
	name, message := strings.TrimSpace(input.Name), strings.TrimSpace(input.Message)
	if len(name) < 1 || len(name) > 180 || len(message) > 120 {
		return fmt.Errorf("%w: name or message is outside its allowed length", ErrInvalid)
	}
	if input.WarningLevel < 1 || input.WarningLevel > 99 ||
		input.LoudLevel < 2 || input.LoudLevel > 100 {
		return fmt.Errorf("%w: noise levels must be between 1 and 100 on the relative scale", ErrInvalid)
	}
	// One threshold for both directions is what makes a bar flap on and off
	// around a single value, so the two are required to differ.
	if input.WarningLevel >= input.LoudLevel {
		return fmt.Errorf("%w: warningLevel must be below loudLevel", ErrInvalid)
	}
	if input.Sensitivity < 25 || input.Sensitivity > 300 {
		return fmt.Errorf("%w: sensitivity must be between 25 and 300 percent", ErrInvalid)
	}
	if input.TriggerHoldMS < 100 || input.TriggerHoldMS > 10_000 ||
		input.ClearHoldMS < 500 || input.ClearHoldMS > 30_000 {
		return fmt.Errorf("%w: trigger and clear holds are outside their allowed ranges", ErrInvalid)
	}
	if input.DisplayMode != "overlay" && input.DisplayMode != "push" {
		return fmt.Errorf("%w: displayMode must be overlay or push", ErrInvalid)
	}
	if input.HeightPX < 40 || input.HeightPX > 320 {
		return fmt.Errorf("%w: heightPx must be between 40 and 320", ErrInvalid)
	}
	if !noiseMeterRetentionDays[input.HistoryRetentionDays] {
		return fmt.Errorf("%w: historyRetentionDays must be 1, 3, 7, 14, or 30", ErrInvalid)
	}
	if err := validateNoiseMeterSchedule(input); err != nil {
		return err
	}
	return validateTargeting(input.TargetScope, input.TargetIDs)
}

// scheduleTime keeps an unset bound NULL rather than an empty string, which
// Postgres would refuse to cast to `time`.
func scheduleTime(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return strings.TrimSpace(*value)
}

// validateNoiseMeterSchedule checks the optional display window. A window that
// is switched on has to name days and both bounds: one that cannot open would
// hide the bar permanently, which is never what an operator meant.
func validateNoiseMeterSchedule(input NoiseMeterInput) error {
	if _, err := time.LoadLocation(input.ScheduleTimezone); err != nil {
		return fmt.Errorf("%w: scheduleTimezone is not a valid IANA timezone", ErrInvalid)
	}
	if !input.ScheduleEnabled {
		return nil
	}
	if input.ScheduleStartTime == nil || input.ScheduleEndTime == nil {
		return fmt.Errorf("%w: a display window requires a start and an end time", ErrInvalid)
	}
	for _, value := range []*string{input.ScheduleStartTime, input.ScheduleEndTime} {
		if _, err := time.Parse("15:04", strings.TrimSpace(*value)); err != nil {
			return fmt.Errorf("%w: display window times must use HH:MM", ErrInvalid)
		}
	}
	// An end at or before the start is an overnight window, not an error; a
	// window with the same start and end would never be open at all.
	if strings.TrimSpace(*input.ScheduleStartTime) == strings.TrimSpace(*input.ScheduleEndTime) {
		return fmt.Errorf("%w: a display window must start and end at different times", ErrInvalid)
	}
	if len(input.ScheduleDaysOfWeek) == 0 {
		return fmt.Errorf("%w: a display window requires at least one day", ErrInvalid)
	}
	seen := map[int]bool{}
	for _, day := range input.ScheduleDaysOfWeek {
		if day < 0 || day > 6 || seen[day] {
			return fmt.Errorf("%w: scheduleDaysOfWeek must contain unique values from 0 through 6", ErrInvalid)
		}
		seen[day] = true
	}
	return nil
}

// noiseMetersForScreen projects at most one meter. A screen has one microphone,
// so two applicable instances cannot both run; the lowest stable instance ID
// wins rather than an operator-facing priority nobody would enjoy tuning.
func (s *Service) noiseMetersForScreen(ctx context.Context, screenID uuid.UUID) ([]ManifestPlugin, error) {
	row := s.db.QueryRow(ctx, `SELECT DISTINCT i.id,i.name,i.message,i.warning_level,i.loud_level,i.sensitivity,
		i.trigger_hold_ms,i.clear_hold_ms,i.display_mode,i.height_px,
		i.history_enabled,i.history_retention_days,i.history_active_hours_only,
		i.schedule_enabled,i.schedule_days_of_week,i.schedule_start_time::text,i.schedule_end_time::text,
		i.schedule_timezone
		`+targetScopeFilter("noise_meter_instances", "noise_meter_targets")+`
		ORDER BY i.id LIMIT 1`, screenID)
	var id uuid.UUID
	var config ManifestNoiseMeterConfig
	err := row.Scan(&id, &config.Name, &config.Message, &config.WarningLevel, &config.LoudLevel,
		&config.Sensitivity, &config.TriggerHoldMS, &config.ClearHoldMS, &config.DisplayMode, &config.HeightPX,
		&config.HistoryEnabled, &config.HistoryRetentionDays, &config.HistoryActiveHoursOnly,
		&config.ScheduleEnabled, &config.ScheduleDaysOfWeek, &config.ScheduleStartTime,
		&config.ScheduleEndTime, &config.ScheduleTimezone)
	if errors.Is(err, pgx.ErrNoRows) {
		return []ManifestPlugin{}, nil
	}
	if err != nil {
		return nil, err
	}
	config.ScheduleStartTime = trimTargetTime(config.ScheduleStartTime)
	config.ScheduleEndTime = trimTargetTime(config.ScheduleEndTime)
	return []ManifestPlugin{{ID: id, Type: "noise_meter", Version: 1, Config: config}}, nil
}
