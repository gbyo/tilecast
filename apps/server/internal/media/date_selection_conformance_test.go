package media

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestWidgetDateSelectionConformance(t *testing.T) {
	encoded, err := os.ReadFile("../../../../packages/manifest-schema/date-selection-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		ID             string             `json:"id"`
		At             time.Time          `json:"at"`
		FirstDayOfWeek string             `json:"firstDayOfWeek"`
		Selection      DateSelection      `json:"selection"`
		Records        []StructuredRecord `json:"records"`
		ExpectedIDs    []string           `json:"expectedIds"`
	}
	if err := json.Unmarshal(encoded, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) < 13 {
		t.Fatal("date-selection corpus is incomplete")
	}
	for _, fixture := range fixtures {
		t.Run(fixture.ID, func(t *testing.T) {
			loc, err := time.LoadLocation(fixture.Selection.Timezone)
			if err != nil {
				t.Fatal(err)
			}
			previewDate := fixture.At.In(loc).Format("2006-01-02")
			selected := selectStructuredRecords(fixture.Records, fixture.Selection, previewDate, firstDayForRegionalSettings(fixture.FirstDayOfWeek, "en-US"))
			ids := make([]string, 0, len(selected))
			for _, record := range selected {
				ids = append(ids, record.ID)
			}
			if !reflect.DeepEqual(ids, fixture.ExpectedIDs) {
				t.Fatalf("selected=%v want=%v", ids, fixture.ExpectedIDs)
			}
		})
	}
}
