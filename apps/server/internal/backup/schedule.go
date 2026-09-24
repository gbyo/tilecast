package backup

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ScheduleConfig is the parsed scheduled-backup configuration from the
// settings registry.
type ScheduleConfig struct {
	Enabled          bool
	Frequency        string // daily or weekly
	Weekday          time.Weekday
	Hour             int
	Minute           int
	Location         *time.Location
	RetentionCount   int
	RetentionAgeDays int
}

var weekdayNames = map[string]time.Weekday{
	"sunday":    time.Sunday,
	"monday":    time.Monday,
	"tuesday":   time.Tuesday,
	"wednesday": time.Wednesday,
	"thursday":  time.Thursday,
	"friday":    time.Friday,
	"saturday":  time.Saturday,
}

// ParseScheduleSettings builds a ScheduleConfig from raw organization
// settings values (already validated by the settings registry; defaults are
// applied here for missing keys).
func ParseScheduleSettings(values map[string]any) (ScheduleConfig, error) {
	cfg := ScheduleConfig{
		Enabled:          boolSetting(values, "backups.schedule_enabled", false),
		Frequency:        stringSetting(values, "backups.schedule_frequency", "daily"),
		Weekday:          time.Sunday,
		RetentionCount:   intSetting(values, "backups.retention_max_count", 7),
		RetentionAgeDays: intSetting(values, "backups.retention_max_age_days", 90),
	}
	if day, ok := weekdayNames[stringSetting(values, "backups.schedule_day", "sunday")]; ok {
		cfg.Weekday = day
	}
	clock := stringSetting(values, "backups.schedule_time", "02:30")
	parts := strings.SplitN(clock, ":", 2)
	if len(parts) != 2 {
		return ScheduleConfig{}, fmt.Errorf("invalid backup schedule time %q", clock)
	}
	hour, err := strconv.Atoi(parts[0])
	if err != nil || hour < 0 || hour > 23 {
		return ScheduleConfig{}, fmt.Errorf("invalid backup schedule time %q", clock)
	}
	minute, err := strconv.Atoi(parts[1])
	if err != nil || minute < 0 || minute > 59 {
		return ScheduleConfig{}, fmt.Errorf("invalid backup schedule time %q", clock)
	}
	cfg.Hour, cfg.Minute = hour, minute
	zone := stringSetting(values, "backups.schedule_timezone", "UTC")
	location, err := time.LoadLocation(zone)
	if err != nil {
		return ScheduleConfig{}, fmt.Errorf("invalid backup schedule timezone %q", zone)
	}
	cfg.Location = location
	return cfg, nil
}

// NextRun computes the first scheduled occurrence strictly after the given
// time, honoring the configured IANA timezone. A wall-clock time that falls
// inside a spring-forward gap is shifted forward by that gap, so a 02:30
// schedule becomes 03:30 rather than running early or disappearing that day.
func (c ScheduleConfig) NextRun(after time.Time) time.Time {
	local := after.In(c.Location)
	for day := 0; day <= 8; day++ {
		candidate := scheduledWallTime(local.Year(), local.Month(), local.Day()+day, c.Hour, c.Minute, c.Location)
		if !candidate.After(after) {
			continue
		}
		if c.Frequency == "weekly" && candidate.Weekday() != c.Weekday {
			continue
		}
		return candidate
	}
	// Unreachable: eight days always cover a weekly schedule.
	return after.Add(24 * time.Hour)
}

// scheduledWallTime preserves time.Date's normal handling of valid and
// repeated wall times. For a nonexistent spring-forward time, Go may instead
// normalize backward (for example, New York 2026-03-08 02:30 becomes 01:30
// EST). Move that result forward by the missing wall-clock interval so the
// scheduled job runs after the gap, at 03:30 EDT in that example.
func scheduledWallTime(year int, month time.Month, day, hour, minute int, location *time.Location) time.Time {
	candidate := time.Date(year, month, day, hour, minute, 0, 0, location)
	local := candidate.In(location)
	if local.Year() != year || local.Month() != month || local.Day() != day {
		return candidate
	}

	requestedMinute := hour*60 + minute
	actualMinute := local.Hour()*60 + local.Minute()
	if actualMinute >= requestedMinute {
		return candidate
	}
	return candidate.Add(time.Duration(requestedMinute-actualMinute) * time.Minute)
}

func boolSetting(values map[string]any, key string, fallback bool) bool {
	if value, ok := values[key].(bool); ok {
		return value
	}
	return fallback
}

func stringSetting(values map[string]any, key string, fallback string) string {
	if value, ok := values[key].(string); ok && value != "" {
		return value
	}
	return fallback
}

func intSetting(values map[string]any, key string, fallback int) int {
	switch value := values[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case int64:
		return int(value)
	}
	return fallback
}
