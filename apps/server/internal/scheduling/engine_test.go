package scheduling

import (
	"encoding/json"
	"github.com/google/uuid"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
)

func p[T any](v T) *T { return &v }
func TestPrecedenceAndHalfOpen(t *testing.T) {
	at := time.Date(2026, 7, 12, 16, 0, 0, 0, time.UTC)
	a := Schedule{ID: uuid.MustParse("00000000-0000-0000-0000-000000000002"), PlaylistID: uuid.New(), Type: OneTime, Timezone: "UTC", Priority: 100, Specificity: 0, Enabled: true, OneTimeStart: p(at.Add(-time.Hour)), OneTimeEnd: p(at.Add(time.Hour))}
	b := a
	b.ID = uuid.MustParse("00000000-0000-0000-0000-000000000001")
	b.Specificity = 1
	if got := Resolve(at, []Schedule{a, b}).Winner; got == nil || got.Schedule.ID != b.ID {
		t.Fatal("screen target did not win")
	}
	if Resolve(*b.OneTimeEnd, []Schedule{b}).Winner != nil {
		t.Fatal("end must be exclusive")
	}
}

func TestDisplayControlScheduleUsesNormalPrecedence(t *testing.T) {
	at := time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
	brightness := 50
	schedules := []Schedule{
		{ID: uuid.New(), Type: OneTime, Timezone: "UTC", Priority: 10, Enabled: true, DisplayAction: &displaycontrol.Action{Type: displaycontrol.CommandPowerOn}, OneTimeStart: p(at.Add(-time.Hour)), OneTimeEnd: p(at.Add(time.Hour))},
		{ID: uuid.New(), Type: OneTime, Timezone: "UTC", Priority: 20, Enabled: true, DisplayAction: &displaycontrol.Action{Type: displaycontrol.CommandSetBrightness, Brightness: &brightness}, OneTimeStart: p(at.Add(-time.Hour)), OneTimeEnd: p(at.Add(time.Hour))},
	}
	result := Resolve(at, schedules)
	if result.Winner == nil || result.Winner.Schedule.DisplayAction == nil || result.Winner.Schedule.DisplayAction.Type != displaycontrol.CommandSetBrightness {
		t.Fatalf("winner=%#v", result.Winner)
	}
}

func TestDisplayControlScheduleRequiresValidAction(t *testing.T) {
	if err := Validate(Schedule{Type: OneTime, Timezone: "UTC", Enabled: true, DisplayAction: &displaycontrol.Action{Type: displaycontrol.CommandPowerOn}, OneTimeStart: p(time.Now()), OneTimeEnd: p(time.Now().Add(time.Hour))}); err != nil {
		t.Fatal(err)
	}
	if err := (&displaycontrol.Action{Type: displaycontrol.CommandSetVolume}).Validate(); err == nil {
		t.Fatal("incomplete action was accepted")
	}
}
func TestSharedParityFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/manifest-schema/schedule-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name               string     `json:"name"`
		Now                time.Time  `json:"now"`
		Schedules          []Schedule `json:"schedules"`
		ExpectedScheduleID string     `json:"expectedScheduleId"`
		ExpectedPlaylistID string     `json:"expectedPlaylistId"`
		ExpectedSource     string     `json:"expectedSource"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			r := Resolve(f.Now, f.Schedules)
			explanation := Explain(f.Now, f.Schedules)
			if !reflect.DeepEqual(explanation.Resolution, r) {
				t.Fatal("explanation changed the schedule fixture resolution")
			}
			selected := 0
			for _, candidate := range explanation.Candidates {
				if candidate.Status == CandidateSelected {
					selected++
					if candidate.ScheduleID.String() != f.ExpectedScheduleID || candidate.Reason != ReasonSelected {
						t.Fatalf("fixture selected explanation=%+v", candidate)
					}
				}
			}
			if (r.Winner == nil && selected != 0) || (r.Winner != nil && selected != 1) {
				t.Fatalf("selected candidates=%d winner=%+v", selected, r.Winner)
			}
			schedule, playlist, source := "", "fallback", "direct_fallback"
			if r.Winner != nil {
				schedule = r.Winner.Schedule.ID.String()
				playlist = r.Winner.Schedule.PlaylistID.String()
				source = "schedule"
			}
			if schedule != f.ExpectedScheduleID || playlist != f.ExpectedPlaylistID || source != f.ExpectedSource {
				t.Fatalf("got %s %s %s", schedule, playlist, source)
			}
		})
	}
}
func TestOvernightAndDST(t *testing.T) {
	s := Schedule{ID: uuid.New(), PlaylistID: uuid.New(), Type: Weekly, Timezone: "America/New_York", Enabled: true, DailyStart: p("22:00"), DailyEnd: p("02:00"), DaysOfWeek: []int{5}}
	at := time.Date(2026, 7, 11, 5, 0, 0, 0, time.UTC)
	if Resolve(at, []Schedule{s}).Winner == nil {
		t.Fatal("Friday overnight must remain active Saturday")
	}
	spring := s
	spring.DaysOfWeek = []int{0}
	spring.DailyStart = p("02:30")
	spring.DailyEnd = p("04:00")
	r := Resolve(time.Date(2026, 3, 8, 7, 15, 0, 0, time.UTC), []Schedule{spring})
	if r.Winner == nil || r.Winner.Start != time.Date(2026, 3, 8, 7, 0, 0, 0, time.UTC) {
		t.Fatalf("nonexistent start policy: %#v", r.Winner)
	}
	fall := s
	fall.DaysOfWeek = []int{0}
	fall.DailyStart = p("01:30")
	fall.DailyEnd = p("01:45")
	r = Resolve(time.Date(2026, 11, 1, 6, 35, 0, 0, time.UTC), []Schedule{fall})
	if r.Winner == nil || r.Winner.Start != time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC) || r.Winner.End != time.Date(2026, 11, 1, 6, 45, 0, 0, time.UTC) {
		t.Fatalf("ambiguous time policy: %#v", r.Winner)
	}
}
