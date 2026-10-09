package scheduling

import (
	"testing"
	"time"
)

func TestOneTimeWindowRespectsCampaignDateBounds(t *testing.T) {
	start := time.Date(2026, time.April, 10, 9, 30, 0, 0, time.UTC)
	end := time.Date(2026, time.April, 10, 11, 30, 0, 0, time.UTC)
	campaignStart, campaignEnd := "2026-04-12", "2026-04-15"
	bounded := Schedule{
		Type:         OneTime,
		Timezone:     "UTC",
		Enabled:      true,
		OneTimeStart: &start,
		OneTimeEnd:   &end,
		StartDate:    &campaignStart,
		EndDate:      &campaignEnd,
	}
	at := time.Date(2026, time.April, 10, 10, 0, 0, 0, time.UTC)
	if got := Resolve(at, []Schedule{bounded}); got.Winner != nil {
		t.Fatalf("window before the Campaign started resolved as active: %+v", got.Winner)
	}
	if _, ok := NextInterval(bounded, at.Add(-time.Hour)); ok {
		t.Fatal("window before the Campaign started has a next interval")
	}

	inside := bounded
	inside.StartDate, inside.EndDate = nil, nil
	inside.OneTimeStart = ptrTime(time.Date(2026, time.April, 13, 9, 30, 0, 0, time.UTC))
	inside.OneTimeEnd = ptrTime(time.Date(2026, time.April, 13, 11, 30, 0, 0, time.UTC))
	inside.StartDate, inside.EndDate = &campaignStart, &campaignEnd
	at = time.Date(2026, time.April, 13, 10, 0, 0, 0, time.UTC)
	if got := Resolve(at, []Schedule{inside}); got.Winner == nil {
		t.Fatal("window inside the Campaign did not resolve as active")
	}
}
