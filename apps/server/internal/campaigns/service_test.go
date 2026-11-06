package campaigns

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestNormalizeSnapshotCreatesStableAuthoringDefaults(t *testing.T) {
	snapshot := Snapshot{Name: "Morning", Destinations: nil, Blocks: []Block{{ContentType: "playlist", ContentID: uuid.New()}}}
	normalizeSnapshot(&snapshot)

	if snapshot.Timezone != "UTC" {
		t.Fatalf("timezone = %q, want UTC", snapshot.Timezone)
	}
	if snapshot.Destinations == nil || snapshot.Blocks == nil {
		t.Fatal("normalization should allocate empty collections")
	}
	if snapshot.Blocks[0].ID == uuid.Nil || snapshot.Blocks[0].Name != "Block 1" || snapshot.Blocks[0].Timezone != "UTC" {
		t.Fatalf("normalized block = %#v", snapshot.Blocks[0])
	}
}

func TestValidateSnapshotShapeRejectsAmbiguousReferences(t *testing.T) {
	id := uuid.New()
	snapshot := Snapshot{
		Name:         "Morning",
		Timezone:     "UTC",
		Destinations: []Destination{{Type: "screen", ID: id}, {Type: "screen", ID: id}},
		Blocks:       []Block{{ID: id, Name: "Playlist", ContentType: "playlist", ContentID: uuid.New(), Timezone: "UTC"}},
	}
	if err := validateSnapshotShape(snapshot); err == nil || !strings.Contains(err.Error(), "listed more than once") {
		t.Fatalf("duplicate destination error = %v", err)
	}

	snapshot.Destinations = []Destination{{Type: "screen", ID: uuid.New()}}
	snapshot.Blocks = append(snapshot.Blocks, Block{ID: id, Name: "Other", ContentType: "layout", ContentID: uuid.New(), Timezone: "UTC"})
	if err := validateSnapshotShape(snapshot); err == nil || !strings.Contains(err.Error(), "content block") {
		t.Fatalf("duplicate block error = %v", err)
	}
}

func TestValidateSnapshotShapeRejectsInvalidScheduleTimezone(t *testing.T) {
	snapshot := Snapshot{
		Name:         "Morning",
		Timezone:     "UTC",
		Destinations: []Destination{{Type: "screen", ID: uuid.New()}},
		Blocks:       []Block{{ID: uuid.New(), Name: "Playlist", ContentType: "playlist", ContentID: uuid.New(), Timezone: "Not/AZone"}},
	}
	if err := validateSnapshotShape(snapshot); err == nil || !strings.Contains(err.Error(), "timezone") {
		t.Fatalf("invalid timezone error = %v", err)
	}
}

func TestCampaignDateBoundsUseTheBlockTimeZoneAndAnExclusiveEnd(t *testing.T) {
	// A Los Angeles Campaign that runs through the end of November 30. In UTC
	// its end falls on December 1, which must not become a schedule date.
	start := time.Date(2026, 11, 10, 9, 0, 0, 0, mustLocation(t, "America/Los_Angeles"))
	end := time.Date(2026, 12, 1, 0, 0, 0, 0, mustLocation(t, "America/Los_Angeles"))
	snapshot := Snapshot{CampaignStart: &start, CampaignEnd: &end}
	from, until := campaignDateBounds(Block{Timezone: "America/Los_Angeles"}, snapshot)
	if from == nil || until == nil || *from != "2026-11-10" || *until != "2026-11-30" {
		t.Fatalf("bounds=%v..%v", deref(from), deref(until))
	}
	// A Tokyo Campaign that starts at local midnight starts on that date, not
	// on the previous UTC date.
	tokyo := time.Date(2026, 11, 10, 0, 0, 0, 0, mustLocation(t, "Asia/Tokyo"))
	from, _ = campaignDateBounds(Block{Timezone: "Asia/Tokyo"}, Snapshot{CampaignStart: &tokyo})
	if from == nil || *from != "2026-11-10" {
		t.Fatalf("Tokyo start=%v", deref(from))
	}
	// A block's own dates are kept.
	own := "2026-11-15"
	from, until = campaignDateBounds(Block{Timezone: "UTC", StartDate: &own, EndDate: &own}, snapshot)
	if *from != own || *until != own {
		t.Fatalf("block dates were replaced: %v..%v", deref(from), deref(until))
	}
}

func mustLocation(t *testing.T, name string) *time.Location {
	t.Helper()
	location, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return location
}

func deref(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}
