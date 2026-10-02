package media

import "time"

// previewDateAt resolves a date-only preview in the provider's timezone.
// It rejects impossible dates instead of allowing time.ParseInLocation to
// normalize them into a different calendar day.
func previewDateAt(previewDate, timezone string) (time.Time, bool) {
	if previewDate == "" {
		return time.Time{}, false
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		location = time.UTC
	}
	date, err := time.ParseInLocation("2006-01-02", previewDate, location)
	if err != nil || date.Format("2006-01-02") != previewDate {
		return time.Time{}, false
	}
	return date, true
}

func previewTimeOrNow(previewDate, timezone string, now time.Time) time.Time {
	if date, ok := previewDateAt(previewDate, timezone); ok {
		return date
	}
	return now
}
