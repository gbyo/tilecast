package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/playbackplan"
)

var playbackPlanTimeFormat = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$`)

func playbackPlanInstant(rawQuery string) (*time.Time, error) {
	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return nil, playbackplan.ErrInvalidInspection
	}
	for key := range query {
		if key != "at" {
			return nil, playbackplan.ErrInvalidInspection
		}
	}
	values, present := query["at"]
	if !present {
		return nil, nil
	}
	if len(values) != 1 || !playbackPlanTimeFormat.MatchString(values[0]) {
		return nil, playbackplan.ErrInvalidInspection
	}
	at, err := time.Parse(time.RFC3339Nano, values[0])
	if err != nil || at.IsZero() {
		return nil, playbackplan.ErrInvalidInspection
	}
	return &at, nil
}

func (s *server) getPlaybackPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	at, err := playbackPlanInstant(r.URL.RawQuery)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_playback_plan_instant", "Use one RFC 3339 instant with a time zone, or omit at for server time.")
		return
	}
	inspection, err := s.playbackPlan.Inspect(r.Context(), id, at)
	switch {
	case errors.Is(err, playbackplan.ErrNotFound):
		writeError(w, http.StatusNotFound, "screen_not_found", "Screen was not found.")
	case errors.Is(err, playbackplan.ErrInvalidInspection), errors.Is(err, playbackplan.ErrInvalidCurrentInspection):
		writeError(w, http.StatusBadRequest, "invalid_playback_plan_instant", "A Screen and a valid inspection instant are required.")
	case errors.Is(err, playbackplan.ErrAmbiguousExpectation):
		writeError(w, http.StatusConflict, "playback_expectation_ambiguous", "Recorded playback expectations overlap at this instant.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"data": inspection.Response()})
	}
}

func playbackAgendaRange(rawQuery string) (time.Time, time.Time, error) {
	query, err := url.ParseQuery(rawQuery)
	if err != nil || len(query) != 2 {
		return time.Time{}, time.Time{}, playbackplan.ErrInvalidAgendaRange
	}
	parse := func(values []string) (time.Time, error) {
		if len(values) != 1 || !playbackPlanTimeFormat.MatchString(values[0]) {
			return time.Time{}, playbackplan.ErrInvalidAgendaRange
		}
		return time.Parse(time.RFC3339Nano, values[0])
	}
	from, err := parse(query["from"])
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	to, err := parse(query["to"])
	return from, to, err
}

func (s *server) getPlaybackAgenda(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	from, to, err := playbackAgendaRange(r.URL.RawQuery)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_playback_agenda_range", "Use one RFC 3339 instant each for from and to, with time zones.")
		return
	}
	agenda, err := s.playbackAgenda.Agenda(r.Context(), id, from, to)
	switch {
	case errors.Is(err, playbackplan.ErrNotFound):
		writeError(w, http.StatusNotFound, "screen_not_found", "Screen was not found.")
	case errors.Is(err, playbackplan.ErrInvalidAgendaRange):
		writeError(w, http.StatusBadRequest, "invalid_playback_agenda_range", "Use a positive range of at most eight days.")
	case errors.Is(err, playbackplan.ErrAgendaTooManyChanges):
		writeError(w, http.StatusUnprocessableEntity, "playback_agenda_too_many_changes", "This range contains too many schedule boundaries.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"data": agenda})
	}
}
