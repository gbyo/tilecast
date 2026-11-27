package plugins

import (
	"fmt"
	"sort"
	"time"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Host schedule semantics of Plugin Manifest API 3 instance kinds. The host
// decides when it projects an instance; a domain calendar stays plugin
// data. A window projects from StartsAt until EndsAt. A weekly schedule
// projects on its days from StartTime until EndTime in its timezone; a
// period that would cross midnight is two schedules or plugin data.

const maxScheduleWindow = 366 * 24 * time.Hour

func validateSchedule(mode string, schedule *plugin.InstanceSchedule) (*plugin.InstanceSchedule, error) {
	switch mode {
	case plugin.ScheduleNone:
		if schedule != nil {
			return nil, fmt.Errorf("%w: this kind has no schedule", plugin.ErrInvalid)
		}
		return nil, nil
	case plugin.ScheduleWindow:
		if schedule == nil || schedule.StartsAt == nil || schedule.EndsAt == nil {
			return nil, fmt.Errorf("%w: schedule needs startsAt and endsAt", plugin.ErrInvalid)
		}
		if schedule.Timezone != "" || len(schedule.Days) > 0 || schedule.StartTime != "" || schedule.EndTime != "" {
			return nil, fmt.Errorf("%w: a window schedule has only startsAt and endsAt", plugin.ErrInvalid)
		}
		starts, ends := schedule.StartsAt.UTC().Truncate(time.Second), schedule.EndsAt.UTC().Truncate(time.Second)
		if !ends.After(starts) || ends.Sub(starts) > maxScheduleWindow {
			return nil, fmt.Errorf("%w: endsAt must be after startsAt and within 366 days of it", plugin.ErrInvalid)
		}
		return &plugin.InstanceSchedule{StartsAt: &starts, EndsAt: &ends}, nil
	case plugin.ScheduleWeekly:
		if schedule == nil {
			return nil, fmt.Errorf("%w: schedule needs a timezone, days, startTime, and endTime", plugin.ErrInvalid)
		}
		if schedule.StartsAt != nil || schedule.EndsAt != nil {
			return nil, fmt.Errorf("%w: a weekly schedule has no startsAt or endsAt", plugin.ErrInvalid)
		}
		if _, err := time.LoadLocation(schedule.Timezone); err != nil || schedule.Timezone == "" {
			return nil, fmt.Errorf("%w: schedule timezone must be an IANA timezone", plugin.ErrInvalid)
		}
		if len(schedule.Days) == 0 || len(schedule.Days) > 7 {
			return nil, fmt.Errorf("%w: schedule needs at least one day", plugin.ErrInvalid)
		}
		seen := map[int]bool{}
		days := []int{}
		for _, day := range schedule.Days {
			if day < 0 || day > 6 || seen[day] {
				return nil, fmt.Errorf("%w: schedule days must be unique values from 0 through 6", plugin.ErrInvalid)
			}
			seen[day] = true
			days = append(days, day)
		}
		sort.Ints(days)
		start, startErr := time.Parse("15:04", schedule.StartTime)
		end, endErr := time.Parse("15:04", schedule.EndTime)
		if startErr != nil || endErr != nil || len(schedule.StartTime) != 5 || len(schedule.EndTime) != 5 || !end.After(start) {
			return nil, fmt.Errorf("%w: schedule startTime and endTime use HH:MM and end after they start", plugin.ErrInvalid)
		}
		return &plugin.InstanceSchedule{Timezone: schedule.Timezone, Days: days, StartTime: schedule.StartTime, EndTime: schedule.EndTime}, nil
	default:
		return nil, fmt.Errorf("%w: unknown schedule mode", plugin.ErrInvalid)
	}
}

// scheduleActive reports whether the host projects the instance at now,
// and until when the current period lasts (zero when it is not active or
// has no end).
func scheduleActive(schedule *plugin.InstanceSchedule, now time.Time) (bool, time.Time) {
	if schedule == nil {
		return true, time.Time{}
	}
	if schedule.StartsAt != nil && schedule.EndsAt != nil {
		if !now.Before(*schedule.StartsAt) && now.Before(*schedule.EndsAt) {
			return true, *schedule.EndsAt
		}
		return false, time.Time{}
	}
	location, err := time.LoadLocation(schedule.Timezone)
	if err != nil {
		return false, time.Time{}
	}
	local := now.In(location)
	start, end, ok := weeklyPeriod(schedule, local)
	if ok && !local.Before(start) && local.Before(end) {
		return true, end
	}
	return false, time.Time{}
}

// weeklyPeriod returns the period of the local day, if the day is listed.
func weeklyPeriod(schedule *plugin.InstanceSchedule, day time.Time) (time.Time, time.Time, bool) {
	listed := false
	for _, value := range schedule.Days {
		listed = listed || value == int(day.Weekday())
	}
	if !listed {
		return time.Time{}, time.Time{}, false
	}
	start, _ := time.Parse("15:04", schedule.StartTime)
	end, _ := time.Parse("15:04", schedule.EndTime)
	year, month, date := day.Date()
	location := day.Location()
	return time.Date(year, month, date, start.Hour(), start.Minute(), 0, 0, location),
		time.Date(year, month, date, end.Hour(), end.Minute(), 0, 0, location), true
}

// nextScheduleChange is the next instant after now when the schedule starts
// or ends a projection, or nil when it never changes again.
func nextScheduleChange(schedule *plugin.InstanceSchedule, now time.Time) *time.Time {
	if schedule == nil {
		return nil
	}
	if schedule.StartsAt != nil && schedule.EndsAt != nil {
		switch {
		case now.Before(*schedule.StartsAt):
			at := schedule.StartsAt.UTC()
			return &at
		case now.Before(*schedule.EndsAt):
			at := schedule.EndsAt.UTC()
			return &at
		}
		return nil
	}
	location, err := time.LoadLocation(schedule.Timezone)
	if err != nil {
		return nil
	}
	local := now.In(location)
	for offset := 0; offset <= 7; offset++ {
		day := local.AddDate(0, 0, offset)
		start, end, ok := weeklyPeriod(schedule, day)
		if !ok {
			continue
		}
		for _, boundary := range []time.Time{start, end} {
			if boundary.After(now) {
				at := boundary.UTC()
				return &at
			}
		}
	}
	return nil
}
