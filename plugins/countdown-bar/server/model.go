package server

import (
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Input is the authored configuration of one Countdown Bar instance: the API
// request body and the stored row.
type Input struct {
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

// CountdownBar is one stored instance as the API returns it.
type CountdownBar struct {
	ID uuid.UUID `json:"id"`
	Input
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
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

// Normalize fills the documented defaults. Omitted values keep the original
// appearance, while a pointer lets zero contentPadding remain an intentional
// full-width choice.
func Normalize(input Input) Input {
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

// Validate is the authoritative rule set for server writes. Studio mirrors
// it for early feedback, but a request is judged here.
func Validate(input Input) error {
	if len(strings.TrimSpace(input.Name)) < 1 || len(strings.TrimSpace(input.Name)) > 180 ||
		len(strings.TrimSpace(input.Message)) < 1 || len(strings.TrimSpace(input.Message)) > 280 ||
		len(strings.TrimSpace(input.CompletionText)) > 280 {
		return plugin.Invalidf("name, message, or completion text is outside its allowed length")
	}
	if _, err := time.LoadLocation(input.Timezone); err != nil {
		return plugin.Invalidf("timezone is not a valid IANA timezone")
	}
	if input.LeadTimeSeconds < 60 || input.LeadTimeSeconds > 2592000 ||
		input.HeightPX < 40 || input.HeightPX > 320 || input.Priority < -1000 || input.Priority > 1000 {
		return plugin.Invalidf("timing, height, or priority is outside its allowed range")
	}
	if input.DisplayMode != "overlay" && input.DisplayMode != "push" {
		return plugin.Invalidf("displayMode must be overlay or push")
	}
	if input.ProgressFill != "none" && input.ProgressFill != "drain" {
		return plugin.Invalidf("progressFill must be none or drain")
	}
	if input.ContentPadding == nil || *input.ContentPadding < 0 || *input.ContentPadding > 40 {
		return plugin.Invalidf("contentPadding must be between 0 and 40 percent")
	}
	if input.TextScale < 25 || input.TextScale > 500 {
		return plugin.Invalidf("textScale must be between 25 and 500 percent")
	}
	if input.StartingSoonSeconds < 2 || input.StartingSoonSeconds > 86400 ||
		input.UrgentSeconds < 2 || input.UrgentSeconds > 3600 || input.PulseSeconds < 1 || input.PulseSeconds > 60 ||
		input.StartingSoonSeconds <= input.UrgentSeconds || input.UrgentSeconds <= input.PulseSeconds {
		return plugin.Invalidf("urgency thresholds must be ordered starting soon, urgent, then pulse")
	}
	switch input.ScheduleType {
	case "weekly":
		if input.TargetTime == nil || input.OneTimeAt != nil || len(input.DaysOfWeek) == 0 {
			return plugin.Invalidf("weekly schedules require a target time and at least one day")
		}
		if _, err := time.Parse("15:04", *input.TargetTime); err != nil {
			return plugin.Invalidf("targetTime must use HH:MM")
		}
		seen := map[int]bool{}
		for _, day := range input.DaysOfWeek {
			if day < 0 || day > 6 || seen[day] {
				return plugin.Invalidf("daysOfWeek must contain unique values from 0 through 6")
			}
			seen[day] = true
		}
	case "one_time":
		if input.OneTimeAt == nil || input.TargetTime != nil || len(input.DaysOfWeek) != 0 {
			return plugin.Invalidf("one-time schedules require oneTimeAt only")
		}
	default:
		return plugin.Invalidf("scheduleType must be weekly or one_time")
	}
	return plugin.Target{Scope: input.TargetScope, IDs: input.TargetIDs}.Validate()
}

// trimTargetTime turns PostgreSQL's HH:MM:SS `time` rendering into the HH:MM
// shape the API, the manifest, and the validator use.
func trimTargetTime(value *string) *string {
	if value == nil || *value == "" {
		return value
	}
	trimmed := strings.TrimSuffix(strings.TrimSuffix(*value, "00"), ":")
	return &trimmed
}
