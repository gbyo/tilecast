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
	sort.Slice(active, func(i, j int) bool {
		before, _ := precedes(active[i], active[j])
		return before
	})
	var winner *Active
	if len(active) > 0 {
		winner = &active[0]
	}
	return Result{Winner: winner, Applicable: active, NextTransition: next}
}

func intervalAt(s Schedule, at time.Time) (*Active, []time.Time) {
	if s.Type == OneTime {
		start, end := *s.OneTimeStart, *s.OneTimeEnd
		var a *Active
		if !at.Before(start) && at.Before(end) {
			a = &Active{s, start, end}
		}
		return a, []time.Time{start, end}
	}
	loc, _ := time.LoadLocation(s.Timezone)
	local := at.In(loc)
	dates := []time.Time{local.AddDate(0, 0, -1), local, local.AddDate(0, 0, 1), local.AddDate(0, 0, 2), local.AddDate(0, 0, 7)}
	var active *Active
	transitions := []time.Time{}
	for _, date := range dates {
		if !containsDay(s.DaysOfWeek, int(date.Weekday())) || !dateAllowed(s, date) {
			continue
		}
		start := resolveLocal(date, *s.DailyStart, loc, false)
		endDate := date
		if *s.DailyEnd <= *s.DailyStart {
			endDate = date.AddDate(0, 0, 1)
		}
		end := resolveLocal(endDate, *s.DailyEnd, loc, true)
		transitions = append(transitions, start, end)
		if !at.Before(start) && at.Before(end) {
			x := Active{s, start, end}
			active = &x
		}
	}
	return active, transitions
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
	t, e := time.Parse("15:04", v)
	if e != nil {
		return t, errors.New("daily time must use HH:MM")
	}
	return t, nil
}

// resolveLocal scans timezone offsets so repeated times select earlier starts/later ends;
// nonexistent wall times advance minute-by-minute to the first valid local time.
func resolveLocal(date time.Time, clock string, loc *time.Location, end bool) time.Time {
	c, _ := parseClock(clock)
	y, m, d := date.Date()
	wanted := time.Date(y, m, d, c.Hour(), c.Minute(), 0, 0, time.UTC)
	matches := []time.Time{}
	for delta := -14 * time.Hour; delta <= 14*time.Hour; delta += time.Minute {
		x := wanted.Add(delta)
		l := x.In(loc)
		if l.Year() == y && l.Month() == m && l.Day() == d && l.Hour() == c.Hour() && l.Minute() == c.Minute() {
			matches = append(matches, x)
		}
	}
	if len(matches) > 0 {
		if end {
			return matches[len(matches)-1]
		}
		return matches[0]
	}
	for minute := 1; minute <= 180; minute++ {
		w := wanted.Add(time.Duration(minute) * time.Minute)
		wy, wm, wd := w.Date()
		for delta := -14 * time.Hour; delta <= 14*time.Hour; delta += time.Minute {
			x := w.Add(delta)
			l := x.In(loc)
			if l.Year() == wy && l.Month() == wm && l.Day() == wd && l.Hour() == w.Hour() && l.Minute() == w.Minute() {
				return x
			}
		}
	}
	return time.Date(y, m, d, c.Hour(), c.Minute(), 0, 0, loc)
}
