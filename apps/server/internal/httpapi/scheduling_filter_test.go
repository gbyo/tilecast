package httpapi

import (
	"net/url"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

func TestScheduleListFilterParsing(t *testing.T) {
	filter, err := scheduleListFilter(url.Values{})
	if err != nil || filter.Enabled != nil || filter.Type != "" || filter.PresentationType != "" || filter.Sort != "" || filter.Search != "" {
		t.Fatalf("an empty query must be the unfiltered library: %+v %v", filter, err)
	}
	filter, err = scheduleListFilter(url.Values{"search": {"lunch"}, "enabled": {"false"}, "type": {"one_time"}, "presentationType": {"display_control"}, "sort": {"priority"}})
	if err != nil {
		t.Fatal(err)
	}
	if filter.Enabled == nil || *filter.Enabled || filter.Type != scheduling.OneTime || filter.PresentationType != scheduling.PresentationDisplayControl || filter.Sort != scheduling.SortPriority || filter.Search != "lunch" {
		t.Fatalf("filter=%+v", filter)
	}
	filter, err = scheduleListFilter(url.Values{"enabled": {"true"}})
	if err != nil || filter.Enabled == nil || !*filter.Enabled {
		t.Fatalf("enabled=true: %+v %v", filter, err)
	}
	for name, query := range map[string]url.Values{
		"enabled":          {"enabled": {"yes"}},
		"type":             {"type": {"daily"}},
		"presentationType": {"presentationType": {"website"}},
		"sort":             {"sort": {"newest"}},
	} {
		if _, err := scheduleListFilter(query); err == nil {
			t.Errorf("%s: an invalid value was accepted", name)
		}
	}
}
