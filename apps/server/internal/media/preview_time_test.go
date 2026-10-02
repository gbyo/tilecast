package media

import (
	"testing"
	"time"
)

func TestPreviewDateAtUsesConfiguredTimezoneAndRejectsInvalidDates(t *testing.T) {
	date, ok := previewDateAt("2026-09-24", "America/New_York")
	if !ok || !date.Equal(time.Date(2026, 9, 24, 0, 0, 0, 0, time.FixedZone("EDT", -4*60*60))) {
		t.Fatalf("preview date = %v, valid=%t", date, ok)
	}
	for _, invalid := range []string{"", "2026-02-30", "2026-9-4", "not-a-date"} {
		if _, ok := previewDateAt(invalid, "UTC"); ok {
			t.Errorf("invalid preview date %q was accepted", invalid)
		}
	}
}

func TestCalendarPreviewWindowMovesWithPreviewDate(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	config := CalendarConfig{Timezone: "America/New_York"}
	start, end := calendarPreviewWindow(now, config, "2026-09-24")
	if got := start.In(time.FixedZone("EDT", -4*60*60)).Format("2006-01-02 15:04"); got != "2026-09-23 00:00" {
		t.Fatalf("window start = %s", got)
	}
	if got := end.In(mustLocation("America/New_York")).Format("2006-01-02 15:04"); got != "2026-12-23 00:00" {
		t.Fatalf("window end = %s", got)
	}
}
