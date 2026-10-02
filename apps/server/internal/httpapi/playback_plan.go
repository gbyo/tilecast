package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/playbackplan"
)

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
	if len(values) != 1 {
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
