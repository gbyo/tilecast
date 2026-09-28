package backup

import (
	"testing"
	"time"
)

func mustParse(t *testing.T, layout, value string, loc *time.Location) time.Time {
	t.Helper()
	parsed, err := time.ParseInLocation(layout, value, loc)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestParseScheduleSettingsDefaults(t *testing.T) {
	cfg, err := ParseScheduleSettings(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Enabled {
		t.Fatal("schedule must default to disabled")
	}
	if cfg.Frequency != "daily" || cfg.Hour != 2 || cfg.Minute != 30 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.Location.String() != "UTC" {
		t.Fatalf("expected UTC default, got %s", cfg.Location)
	}
	if cfg.RetentionCount != 7 || cfg.RetentionAgeDays != 90 {
		t.Fatalf("unexpected retention defaults: %+v", cfg)
	}
}

func TestParseScheduleSettingsRejectsBadValues(t *testing.T) {
	if _, err := ParseScheduleSettings(map[string]any{"backups.schedule_time": "25:00"}); err == nil {
		t.Fatal("expected invalid time to be rejected")
	}
	if _, err := ParseScheduleSettings(map[string]any{"backups.schedule_timezone": "Not/AZone"}); err == nil {
		t.Fatal("expected invalid timezone to be rejected")
	}
}

func TestNextRunDaily(t *testing.T) {
	loc, _ := time.LoadLocation("America/Chicago")
	cfg := ScheduleConfig{Frequency: "daily", Hour: 2, Minute: 30, Location: loc}

	after := mustParse(t, "2006-01-02 15:04", "2026-07-19 01:00", loc)
	next := cfg.NextRun(after)
	if got := next.In(loc).Format("2006-01-02 15:04"); got != "2026-07-19 02:30" {
		t.Fatalf("expected same-day run, got %s", got)
	}

	after = mustParse(t, "2006-01-02 15:04", "2026-07-19 02:30", loc)
	next = cfg.NextRun(after)
	if got := next.In(loc).Format("2006-01-02 15:04"); got != "2026-07-20 02:30" {
		t.Fatalf("expected next-day run, got %s", got)
	}
}

func TestNextRunWeekly(t *testing.T) {
	loc, _ := time.LoadLocation("Europe/Berlin")
	cfg := ScheduleConfig{Frequency: "weekly", Weekday: time.Sunday, Hour: 4, Minute: 0, Location: loc}
	// 2026-07-15 is a Wednesday.
	after := mustParse(t, "2006-01-02 15:04", "2026-07-15 12:00", loc)
	next := cfg.NextRun(after).In(loc)
	if next.Weekday() != time.Sunday || next.Format("2006-01-02 15:04") != "2026-07-19 04:00" {
		t.Fatalf("expected Sunday 2026-07-19 04:00, got %s", next.Format("2006-01-02 15:04 Mon"))
	}
}

func TestNextRunSpringForwardDST(t *testing.T) {
	// US DST starts 2026-03-08: 02:00-03:00 local time does not exist.
	loc, _ := time.LoadLocation("America/New_York")
	cfg := ScheduleConfig{Frequency: "daily", Hour: 2, Minute: 30, Location: loc}

	after := mustParse(t, "2006-01-02 15:04", "2026-03-08 00:00", loc)
	next := cfg.NextRun(after).In(loc)
	if got := next.Format("2006-01-02 15:04 MST"); got != "2026-03-08 03:30 EDT" {
		t.Fatalf("expected gap-day run at 03:30 EDT, got %s", got)
	}

	// Go's time.Date maps this nonexistent 02:30 backward to 01:30 EST. The
	// scheduler must not use that earlier instant: after 01:30, the same day's
	// shifted occurrence is still pending rather than being skipped entirely.
	after = mustParse(t, "2006-01-02 15:04", "2026-03-08 01:45", loc)
	next = cfg.NextRun(after).In(loc)
	if got := next.Format("2006-01-02 15:04 MST"); got != "2026-03-08 03:30 EDT" {
		t.Fatalf("expected same-day shifted run after 01:45, got %s", got)
	}

	// The following day returns to the configured wall-clock time.
	following := cfg.NextRun(next).In(loc)
	if got := following.Format("2006-01-02 15:04 MST"); got != "2026-03-09 02:30 EDT" {
		t.Fatalf("expected 2026-03-09 02:30 EDT, got %s", got)
	}
}

func TestNextRunFallBackDST(t *testing.T) {
	// US DST ends 2026-11-01: 01:00-02:00 local time happens twice.
	loc, _ := time.LoadLocation("America/New_York")
	cfg := ScheduleConfig{Frequency: "daily", Hour: 1, Minute: 30, Location: loc}
	after := mustParse(t, "2006-01-02 15:04", "2026-10-31 23:00", loc)
	first := cfg.NextRun(after).In(loc)
	if first.Day() != 1 || first.Format("15:04") != "01:30" {
		t.Fatalf("expected 2026-11-01 01:30, got %s", first)
	}
	// The next run is a single occurrence the following day, not the repeated
	// hour again.
	second := cfg.NextRun(first).In(loc)
	if second.Day() != 2 || second.Format("15:04") != "01:30" {
		t.Fatalf("expected 2026-11-02 01:30, got %s", second)
	}
}
