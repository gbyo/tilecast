package playbackplan

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

type selectionReaders struct {
	assignment playlists.Assignment
	schedules  []scheduling.Record
	quick      *playlists.PresentationOverride
	takeover   *playlists.ManifestTakeover
	fail       string
	err        error
	instants   []time.Time
}

func (r *selectionReaders) ReadAssignment(context.Context, uuid.UUID) (playlists.Assignment, error) {
	if r.fail == "assignment" {
		return playlists.Assignment{}, r.err
	}
	return r.assignment, nil
}
func (r *selectionReaders) Relevant(context.Context, uuid.UUID) ([]scheduling.Record, error) {
	if r.fail == "schedule" {
		return nil, r.err
	}
	return r.schedules, nil
}
func (r *selectionReaders) ActiveForScreenAt(_ context.Context, _ uuid.UUID, at time.Time) (*playlists.PresentationOverride, error) {
	r.instants = append(r.instants, at)
	if r.fail == "quick" {
		return nil, r.err
	}
	return r.quick, nil
}
func (r *selectionReaders) ActiveTakeoverAt(_ context.Context, _ uuid.UUID, at time.Time) (*playlists.ManifestTakeover, error) {
	r.instants = append(r.instants, at)
	if r.fail == "takeover" {
		return nil, r.err
	}
	return r.takeover, nil
}

func TestCurrentSelectionPrecedenceAndReasons(t *testing.T) {
	at := time.Date(2026, 10, 2, 16, 0, 0, 0, time.UTC)
	start, end := at.Add(-time.Hour), at.Add(time.Hour)
	screen, playlist, layout, scheduled, quick, takeover := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	revision := int64(14)
	makeReaders := func() *selectionReaders {
		return &selectionReaders{
			assignment: playlists.Assignment{PlaylistID: &playlist, PlaylistRevision: &revision, CurrentPlaylistID: &takeover},
			schedules:  []scheduling.Record{{Schedule: scheduling.Schedule{ID: uuid.New(), PlaylistID: scheduled, Enabled: true, Type: scheduling.OneTime, Timezone: "UTC", OneTimeStart: &start, OneTimeEnd: &end}}},
			quick:      &playlists.PresentationOverride{ID: uuid.New(), ContentType: "layout", ContentID: quick, ExpiresAt: &end},
			takeover:   &playlists.ManifestTakeover{ID: uuid.New(), PlaylistID: takeover, ExpiresAt: end},
		}
	}
	for _, test := range []struct {
		name, source, kind, reason string
		id                         uuid.UUID
		prepare                    func(*selectionReaders)
	}{
		{"takeover", "takeover", "playlist", "active_takeover", takeover, func(*selectionReaders) {}},
		{"quick", "quick_present", "layout", "active_quick_present", quick, func(r *selectionReaders) { r.takeover = nil }},
		{"schedule", "schedule", "playlist", "schedule_highest_precedence", scheduled, func(r *selectionReaders) { r.takeover = nil; r.quick = nil }},
		{"assignment", "assignment", "playlist", "assigned_fallback", playlist, func(r *selectionReaders) { r.takeover = nil; r.quick = nil; r.schedules = nil }},
		{"layout", "assignment", "layout", "assigned_fallback", layout, func(r *selectionReaders) {
			r.takeover = nil
			r.quick = nil
			r.schedules = nil
			r.assignment.LayoutID = &layout
			r.assignment.LayoutRevision = &revision
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := makeReaders()
			test.prepare(r)
			got, err := NewCurrent(r, r, r).At(context.Background(), screen, at)
			if err != nil {
				t.Fatal(err)
			}
			if got.Selected == nil || got.Selected.Source != test.source || got.Selected.ContentType != test.kind || got.Selected.ContentID != test.id || got.Selected.Reason != test.reason {
				t.Fatalf("selection=%#v", got.Selected)
			}
			if got.Basis != "current_configuration" || !reflect.DeepEqual(r.instants, []time.Time{at, at}) {
				t.Fatalf("basis or clock: %#v", got)
			}
			for _, candidate := range got.Candidates {
				if candidate.Status == "superseded" && candidate.Reason != test.reason {
					t.Fatalf("wrong supersession: %#v", candidate)
				}
			}
			if test.source != "assignment" && got.Selected.Revision != nil {
				t.Fatal("fallback revision leaked into selected content")
			}
		})
	}
}

func TestCurrentScheduleTraceAndEvaluationBoundary(t *testing.T) {
	at := time.Date(2026, 10, 2, 16, 0, 0, 0, time.UTC)
	start, end, expiry := at.Add(-time.Hour), at.Add(time.Hour), at.Add(time.Minute)
	winner := scheduling.Schedule{ID: uuid.New(), PlaylistID: uuid.New(), Enabled: true, Type: scheduling.OneTime, Timezone: "UTC", Priority: 2, OneTimeStart: &start, OneTimeEnd: &end}
	loser := winner
	loser.ID = uuid.New()
	loser.Priority = 1
	display := winner
	display.ID = uuid.New()
	display.PlaylistID = uuid.Nil
	display.Priority = 999
	r := &selectionReaders{schedules: []scheduling.Record{{Schedule: loser}, {Schedule: display}, {Schedule: winner}}, quick: &playlists.PresentationOverride{ID: uuid.New(), ContentType: "playlist", ContentID: uuid.New(), ExpiresAt: &expiry}}
	got, err := NewCurrent(r, r, r).At(context.Background(), uuid.New(), at)
	if err != nil {
		t.Fatal(err)
	}
	if got.NextEvaluationAt == nil || !got.NextEvaluationAt.Equal(expiry) {
		t.Fatalf("boundary=%v", got.NextEvaluationAt)
	}
	if got.ScheduleExplanation.Resolution.Winner == nil || got.ScheduleExplanation.Resolution.Winner.Schedule.ID != winner.ID || len(got.ScheduleExplanation.Candidates) != 2 {
		t.Fatalf("trace=%#v", got.ScheduleExplanation)
	}
	for _, candidate := range got.Candidates {
		if candidate.Source == "schedule" && *candidate.ID == loser.ID && (candidate.ScheduleReason != scheduling.ReasonLowerPriority || candidate.Reason != "active_quick_present" || candidate.Status != "superseded") {
			t.Fatalf("loser=%#v", candidate)
		}
	}
	r.quick = nil
	r.schedules = nil
	got, err = NewCurrent(r, r, r).At(context.Background(), uuid.New(), at)
	if err != nil || got.Selected != nil || got.NextEvaluationAt != nil {
		t.Fatalf("empty=%#v err=%v", got, err)
	}
	for _, candidate := range got.Candidates {
		if candidate.Status != "inactive" {
			t.Fatalf("empty candidate=%#v", candidate)
		}
	}
}

func TestCurrentRejectsInvalidInspectionAndPropagatesReaderFailures(t *testing.T) {
	service := NewCurrent(nil, nil, nil)
	for _, input := range []struct {
		screen uuid.UUID
		at     time.Time
	}{{uuid.Nil, time.Now()}, {uuid.New(), time.Time{}}} {
		if _, err := service.At(context.Background(), input.screen, input.at); !errors.Is(err, ErrInvalidCurrentInspection) {
			t.Fatalf("invalid error=%v", err)
		}
	}
	failure := errors.New("reader unavailable")
	for _, source := range []string{"assignment", "schedule", "quick", "takeover"} {
		r := &selectionReaders{fail: source, err: failure}
		if _, err := NewCurrent(r, r, r).At(context.Background(), uuid.New(), time.Now()); !errors.Is(err, failure) {
			t.Fatalf("%s error=%v", source, err)
		}
	}
}
