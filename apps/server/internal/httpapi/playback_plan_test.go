package httpapi

import (
	"testing"
	"time"
)

func TestPlaybackPlanInstant(t *testing.T) {
	for _, query := range []string{"at=", "at=2026-10-02", "at=2026-10-02T16:00:00", "at=0001-01-01T00:00:00Z", "at=2026-10-02T16:00:00Z&at=2026-10-02T17:00:00Z", "at=%zz", "unknown=1", "at=2026-10-02T16:00:00Z;at=other", "at=2026-10-02T16:00:00%2B24:00", "at=2026-10-02T16:00:00-04:60", "at=2026-10-02T16:00:00,123Z"} {
		t.Run(query, func(t *testing.T) {
			if _, err := playbackPlanInstant(query); err == nil {
				t.Fatalf("accepted ambiguous or invalid query %q", query)
			}
		})
	}
	if at, err := playbackPlanInstant(""); err != nil || at != nil {
		t.Fatalf("omitted instant=%v err=%v", at, err)
	}
	at, err := playbackPlanInstant("at=2026-10-02T12%3A00%3A00.000000123-04%3A00")
	if err != nil || at == nil || !at.Equal(time.Date(2026, 10, 2, 16, 0, 0, 123, time.UTC)) {
		t.Fatalf("RFC 3339 offset and precision=%v err=%v", at, err)
	}
}
