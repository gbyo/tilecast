package server

import (
	"time"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// sampleRecords are fixed sample meetings around now, for a room that has
// "Show sample meetings" on and for Demo Mode. They never read Google.
func sampleRecords(now time.Time) []plugin.FeedRecord {
	day := now.Truncate(time.Hour)
	meetings := []struct {
		id, title  string
		start, end time.Duration
	}{
		{"sample-1", "Weekly planning", -30 * time.Minute, 30 * time.Minute},
		{"sample-2", "Budget review", 90 * time.Minute, 150 * time.Minute},
		{"sample-3", "Interview", 4 * time.Hour, 5 * time.Hour},
		{"sample-4", "Team lunch", 26 * time.Hour, 27 * time.Hour},
	}
	out := make([]plugin.FeedRecord, 0, len(meetings))
	for _, meeting := range meetings {
		out = append(out, plugin.FeedRecord{ID: meeting.id, Values: map[string]any{
			"title": meeting.title, "start": day.Add(meeting.start).UTC().Format(time.RFC3339),
			"end": day.Add(meeting.end).UTC().Format(time.RFC3339), "allDay": false, "status": "confirmed",
		}})
	}
	return out
}
