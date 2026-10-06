package scheduling_test

import (
	"errors"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

func TestListFilterValidate(t *testing.T) {
	valid := []scheduling.ListFilter{
		{},
		{Type: scheduling.Weekly, PresentationType: scheduling.PresentationLayout, Sort: scheduling.SortPriority},
		{Type: scheduling.OneTime, PresentationType: scheduling.PresentationDisplayControl, Sort: scheduling.SortName},
		{PresentationType: scheduling.PresentationPlaylist, Sort: scheduling.SortUpdated},
	}
	for _, filter := range valid {
		if err := filter.Validate(); err != nil {
			t.Errorf("%+v rejected: %v", filter, err)
		}
	}
	invalid := []scheduling.ListFilter{
		{Type: "monthly"},
		{PresentationType: "website"},
		{Sort: "newest"},
		{Sort: "priority; DROP TABLE schedules"},
	}
	for _, filter := range invalid {
		if err := filter.Validate(); !errors.Is(err, scheduling.ErrInvalidFilter) {
			t.Errorf("%+v err=%v, want ErrInvalidFilter", filter, err)
		}
	}
}
