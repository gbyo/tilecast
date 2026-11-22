package server

import (
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Config is the normalized configuration of one instance, as the host
// stores it after checking every field against the manifest's schema.
type Config struct {
	Message             string     `json:"message"`
	CompletionText      string     `json:"completionText"`
	ShowConfetti        bool       `json:"showConfetti"`
	ScheduleType        string     `json:"scheduleType"`
	TargetTime          *string    `json:"targetTime"`
	DaysOfWeek          []int      `json:"daysOfWeek"`
	OneTimeAt           *time.Time `json:"oneTimeAt"`
	Timezone            string     `json:"timezone"`
	LeadTimeSeconds     int        `json:"leadTimeSeconds"`
	DisplayMode         string     `json:"displayMode"`
	HeightPX            int        `json:"heightPx"`
	ProgressFill        string     `json:"progressFill"`
	ContentPadding      int        `json:"contentPadding"`
	TextScale           int        `json:"textScale"`
	FontID              *uuid.UUID `json:"fontId"`
	UrgencyEnabled      bool       `json:"urgencyEnabled"`
	StartingSoonSeconds int        `json:"startingSoonSeconds"`
	UrgentSeconds       int        `json:"urgentSeconds"`
	PulseSeconds        int        `json:"pulseSeconds"`
}

// ManifestConfig is the Player-facing projection (manifest entry type
// `countdown_bar`, version 1). Players cache it and evaluate the schedule
// locally, so every field a Player needs to decide what to show is here.
type ManifestConfig struct {
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

// StateConfig is the Plugin API v2 state: the Player-facing projection plus
// the library font. Players without Plugin API v2 receive ManifestConfig
// alone, so they keep their own face.
type StateConfig struct {
	ManifestConfig
	FontID *uuid.UUID `json:"fontId,omitempty"`
}

// Validate holds the rules the field schema cannot state.
func (c Config) Validate() error {
	if count := utf8.RuneCountInString(c.Message); count < 1 || count > 280 || utf8.RuneCountInString(c.CompletionText) > 280 {
		return plugin.Invalidf("message or completion text is outside its allowed length")
	}
	switch c.ScheduleType {
	case "weekly":
		if c.TargetTime == nil || *c.TargetTime == "" || len(c.DaysOfWeek) == 0 {
			return plugin.Invalidf("weekly schedules require a target time and at least one day")
		}
	case "one_time":
		if c.OneTimeAt == nil {
			return plugin.Invalidf("one-time schedules require oneTimeAt")
		}
	default:
		return plugin.Invalidf("scheduleType must be weekly or one_time")
	}
	if c.StartingSoonSeconds <= c.UrgentSeconds || c.UrgentSeconds <= c.PulseSeconds {
		return plugin.Invalidf("urgency thresholds must be ordered starting soon, urgent, then pulse")
	}
	return nil
}

// Manifest is the Player configuration. Each schedule type carries only
// its own fields, so a value left from the other type never reaches a
// Player.
func (c Config) Manifest(name string, priority int) ManifestConfig {
	out := ManifestConfig{
		Name: name, Message: strings.TrimSpace(c.Message), ScheduleType: c.ScheduleType, Timezone: c.Timezone,
		LeadTimeSeconds: c.LeadTimeSeconds, CompletionText: strings.TrimSpace(c.CompletionText), ShowConfetti: c.ShowConfetti,
		DisplayMode: c.DisplayMode, HeightPX: c.HeightPX, ProgressFill: c.ProgressFill, ContentPadding: c.ContentPadding,
		TextScale: c.TextScale, UrgencyEnabled: c.UrgencyEnabled, StartingSoonSeconds: c.StartingSoonSeconds,
		UrgentSeconds: c.UrgentSeconds, PulseSeconds: c.PulseSeconds, Priority: priority,
	}
	if c.ScheduleType == "weekly" {
		out.TargetTime, out.DaysOfWeek = c.TargetTime, c.DaysOfWeek
	} else {
		out.OneTimeAt = c.OneTimeAt
	}
	return out
}
