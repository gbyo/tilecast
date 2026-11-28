// Package scheduling is the single server authority for schedule activation and precedence.
package scheduling

import (
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
)

type Kind string

const (
	OneTime Kind = "one_time"
	Weekly  Kind = "weekly"
)

type Schedule struct {
	ID            uuid.UUID              `json:"id"`
	PlaylistID    uuid.UUID              `json:"playlistId,omitempty"`
	LayoutID      *uuid.UUID             `json:"layoutId,omitempty"`
	DisplayAction *displaycontrol.Action `json:"displayAction,omitempty"`
	Type          Kind                   `json:"type"`
	Timezone      string                 `json:"timezone"`
	Priority      int                    `json:"priority"`
	Specificity   int                    `json:"specificity"`
	Enabled       bool                   `json:"enabled"`
	StartDate     *string                `json:"startDate,omitempty"`
	EndDate       *string                `json:"endDate,omitempty"`
	OneTimeStart  *time.Time             `json:"oneTimeStart,omitempty"`
	OneTimeEnd    *time.Time             `json:"oneTimeEnd,omitempty"`
	DailyStart    *string                `json:"dailyStart,omitempty"`
	DailyEnd      *string                `json:"dailyEnd,omitempty"`
	DaysOfWeek    []int                  `json:"daysOfWeek,omitempty"`
}
type Active struct {
	Schedule Schedule
	Start    time.Time
	End      time.Time
}
type Result struct {
	Winner         *Active    `json:"winner,omitempty"`
	Applicable     []Active   `json:"applicable"`
	NextTransition *time.Time `json:"nextTransition,omitempty"`
}

func Validate(s Schedule) error {
	if s.Priority < -999 || s.Priority > 999 {
		return errors.New("priority must be between -999 and 999; 1000 is reserved")
	}
	if s.Timezone != "UTC" && !strings.Contains(s.Timezone, "/") {
		return errors.New("timezone must be a valid IANA identifier")
	}
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil || loc.String() == "Local" {
		return errors.New("timezone must be a valid IANA identifier")
	}
	if s.Type == OneTime {
		if s.OneTimeStart == nil || s.OneTimeEnd == nil || !s.OneTimeEnd.After(*s.OneTimeStart) {
			return errors.New("one-time end must be after its start")
		}
		return nil
	}
	if s.Type != Weekly || s.DailyStart == nil || s.DailyEnd == nil || len(s.DaysOfWeek) == 0 {
		return errors.New("weekly schedules require times and at least one weekday")
	}
	if _, err = parseClock(*s.DailyStart); err != nil {
		return err
	}
	if _, err = parseClock(*s.DailyEnd); err != nil {
		return err
	}
	for _, d := range s.DaysOfWeek {
		if d < 0 || d > 6 {
			return errors.New("weekday must be between 0 and 6")
		}
	}
	if s.StartDate != nil {
		if _, err = time.Parse("2006-01-02", *s.StartDate); err != nil {
			return errors.New("start date is malformed")
		}
	}
	if s.EndDate != nil {
		if _, err = time.Parse("2006-01-02", *s.EndDate); err != nil {
			return errors.New("end date is malformed")
		}
	}
	if s.StartDate != nil && s.EndDate != nil && *s.EndDate < *s.StartDate {
		return errors.New("end date must not precede start date")
	}
	return nil
}

func Resolve(at time.Time, schedules []Schedule) Result {
	active := make([]Active, 0)
	var next *time.Time
	for _, s := range schedules {
		if !s.Enabled {
			continue
		}
		a, transitions := intervalAt(s, at)
		if a != nil {
			active = append(active, *a)
		}
		for _, t := range transitions {
			if t.After(at) && (next == nil || t.Before(*next)) {
				x := t
				next = &x
			}
		}
	}
	Rank(active)
	var winner *Active
	if len(active) > 0 {
		winner = &active[0]
	}
	return Result{Winner: winner, Applicable: active, NextTransition: next}
}

// Rank orders simultaneously active schedules by precedence, first winning.
// Resolve and every read-only inspection of a draft share this one ordering.
func Rank(active []Active) {
	sort.Slice(active, func(i, j int) bool {
		before, _ := precedes(active[i], active[j])
		return before
	})
}

// ActiveAt reports the interval of one schedule that contains at. A disabled
// schedule never participates in Resolve; callers that simulate a draft as
// enabled set Enabled before calling.
func ActiveAt(s Schedule, at time.Time) (Active, bool) {
	a, _ := intervalAt(s, at)
	if a == nil {
		return Active{}, false
	}
	return *a, true
}

// nextIntervalHorizonDays bounds the search for a recurring schedule's next
// occurrence, so a date range that opens far ahead is still found.
const nextIntervalHorizonDays = 400

// NextInterval returns the first interval of s that has not ended by from,
// using the same wall-clock and daylight-saving rules as Resolve. It does not
// consider Enabled. It reports false for a one-time schedule already over and
// for a recurring one with no occurrence inside the search horizon.
func NextInterval(s Schedule, from time.Time) (Active, bool) {
	if s.Type == OneTime {
		if s.OneTimeStart == nil || s.OneTimeEnd == nil || !s.OneTimeEnd.After(from) {
			return Active{}, false
		}
		if !oneTimeAllowed(s, *s.OneTimeStart, *s.OneTimeEnd) {
			return Active{}, false
		}
		return Active{s, *s.OneTimeStart, *s.OneTimeEnd}, true
	}
	startClock, endClock, ok := weeklyClocks(s)
	if !ok {
		return Active{}, false
	}
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return Active{}, false
	}
	// Noon keeps date arithmetic away from daylight-saving gaps at midnight.
	y, m, d := from.In(loc).Date()
	date := time.Date(y, m, d-1, 12, 0, 0, 0, loc)
	if s.StartDate != nil {
		if first, parseErr := time.Parse("2006-01-02", *s.StartDate); parseErr == nil {
			fy, fm, fd := first.Date()
			if candidate := time.Date(fy, fm, fd, 12, 0, 0, 0, loc); candidate.After(date) {
				date = candidate
			}
		}
	}
	for offset := 0; offset < nextIntervalHorizonDays; offset++ {
		day := date.AddDate(0, 0, offset)
		if s.EndDate != nil && day.Format("2006-01-02") > *s.EndDate {
			break
		}
		if !containsDay(s.DaysOfWeek, int(day.Weekday())) || !dateAllowed(s, day) {
			continue
		}
		window := weeklyInterval(s, day, startClock, endClock)
		if window.End.After(window.Start) && window.End.After(from) {
			return window, true
		}
	}
	return Active{}, false
}

func intervalAt(s Schedule, at time.Time) (*Active, []time.Time) {
	if s.Type == OneTime {
		start, end := *s.OneTimeStart, *s.OneTimeEnd
		var a *Active
		if !at.Before(start) && at.Before(end) && oneTimeAllowed(s, start, end) {
			a = &Active{s, start, end}
		}
		return a, []time.Time{start, end}
	}
	startClock, endClock, ok := weeklyClocks(s)
	loc, err := time.LoadLocation(s.Timezone)
	if !ok || err != nil {
		return nil, nil
	}
	local := at.In(loc)
	// Use noon for calendar arithmetic: adding a day to a wall time inside a
	// DST gap can normalize back onto the previous date and skip an occurrence.
	y, m, d := local.Date()
	day := time.Date(y, m, d, 12, 0, 0, 0, loc)
	var active *Active
	transitions := []time.Time{}
	for offset := -1; offset <= 7; offset++ {
		date := day.AddDate(0, 0, offset)
		if !containsDay(s.DaysOfWeek, int(date.Weekday())) || !dateAllowed(s, date) {
			continue
		}
		window := weeklyInterval(s, date, startClock, endClock)
		if !window.End.After(window.Start) {
			continue
		}
		transitions = append(transitions, window.Start, window.End)
		if !at.Before(window.Start) && at.Before(window.End) {
			active = &window
		}
	}
	return active, transitions
}

func weeklyClocks(s Schedule) (start, end time.Time, ok bool) {
	if s.DailyStart == nil || s.DailyEnd == nil {
		return start, end, false
	}
	start, startErr := parseClock(*s.DailyStart)
	end, endErr := parseClock(*s.DailyEnd)
	return start, end, startErr == nil && endErr == nil
}

func weeklyInterval(s Schedule, date, startClock, endClock time.Time) Active {
	endDate := date
	if !endClock.After(startClock) {
		endDate = date.AddDate(0, 0, 1)
	}
	return Active{s, resolveLocal(date, startClock, false), resolveLocal(endDate, endClock, true)}
}

// CanActivate reports whether a schedule's definition allows any occurrence at
// all. A one-time window outside its own date bounds never activates in
// Resolve, so a Player must not receive it either: Player-side evaluators
// apply date bounds to recurring windows only.
func CanActivate(s Schedule) bool {
	if s.Type != OneTime {
		return true
	}
	return s.OneTimeStart != nil && s.OneTimeEnd != nil && oneTimeAllowed(s, *s.OneTimeStart, *s.OneTimeEnd)
}

// oneTimeAllowed applies a Campaign's date bounds to a fixed window. The
// window's first and last local days, in the schedule's time zone, must fall
// inside the bounds, as recurring occurrences already do.
func oneTimeAllowed(s Schedule, start, end time.Time) bool {
	if s.StartDate == nil && s.EndDate == nil {
		return true
	}
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return false
	}
	first := start.In(loc).Format("2006-01-02")
	last := end.In(loc).Add(-time.Nanosecond).Format("2006-01-02")
	return (s.StartDate == nil || first >= *s.StartDate) && (s.EndDate == nil || last <= *s.EndDate)
}

func dateAllowed(s Schedule, d time.Time) bool {
	v := d.Format("2006-01-02")
	return (s.StartDate == nil || v >= *s.StartDate) && (s.EndDate == nil || v <= *s.EndDate)
}
func containsDay(days []int, d int) bool {
	for _, x := range days {
		if x == d {
			return true
		}
	}
	return false
}
func parseClock(v string) (time.Time, error) {
	layout := "15:04"
	if len(v) == len("15:04:05") {
		layout = "15:04:05"
	}
	clock, err := time.Parse(layout, v)
	if err != nil || clock.Nanosecond() != 0 {
		return time.Time{}, errors.New("daily time must use HH:MM or HH:MM:SS")
	}
	return clock, nil
}

// Walk the timezone's offset intervals around the requested local time.
// Repeated times select earlier starts and later ends. Gaps snap to the
// transition instant, the first valid local time after the gap.
func resolveLocal(date, clock time.Time, end bool) time.Time {
	y, m, d := date.Date()
	loc := date.Location()
	wanted := time.Date(y, m, d, clock.Hour(), clock.Minute(), clock.Second(), 0, time.UTC)
	// All IANA UTC offsets fit inside this search window.
	limit := wanted.Add(24 * time.Hour)
	var latest, gapEnd time.Time
	for cursor := wanted.Add(-24 * time.Hour).In(loc); !cursor.After(limit); {
		_, offset := cursor.Zone()
		_, next := cursor.ZoneBounds()
		candidate := wanted.Add(-time.Duration(offset) * time.Second)
		if candidate.Before(cursor) {
			if gapEnd.IsZero() {
				gapEnd = cursor.UTC()
			}
		} else if !candidate.After(limit) && (next.IsZero() || candidate.Before(next)) {
			if !end {
				return candidate
			}
			latest = candidate
		}
		if next.IsZero() || !next.After(cursor) {
			break
		}
		cursor = next
	}
	if !latest.IsZero() {
		return latest
	}
	if !gapEnd.IsZero() {
		return gapEnd
	}
	return time.Date(y, m, d, clock.Hour(), clock.Minute(), clock.Second(), 0, loc)
}
