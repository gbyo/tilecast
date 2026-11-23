package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// One room's sync. The state of a room is one storage.kv@1 value: the
// calendar it was read from, the Google sync token, how far ahead the
// stored events reach, and the events in that range. OAuth tokens are never
// here; the host keeps them.

// Room state bounds. One KV value is at most 64 KiB, which holds the
// events of a busy room for two weeks.
const (
	maxStoredEvents  = 250
	maxPublished     = 200
	coverageMargin   = 2 * 24 * time.Hour
	keepPastMeetings = time.Hour
	// validFor is how long Players treat a publication as current. Each
	// sync extends it; a sign whose syncs stop shows that its schedule may
	// be out of date.
	validFor = 30 * time.Minute
)

type storedEvent struct {
	Title  string `json:"t,omitempty"`
	Start  int64  `json:"s"`
	End    int64  `json:"e"`
	AllDay bool   `json:"a,omitempty"`
	Status string `json:"st,omitempty"`
}

type roomState struct {
	CalendarID string                 `json:"calendarId"`
	Connection uuid.UUID              `json:"connection"`
	SyncToken  string                 `json:"syncToken,omitempty"`
	TimeZone   string                 `json:"timeZone,omitempty"`
	Coverage   int64                  `json:"coverage"`
	Events     map[string]storedEvent `json:"events"`
}

func stateKey(room uuid.UUID) string { return "room:" + room.String() }

// recordID is a stable feed record ID of at most 80 characters. Google
// event IDs of recurring instances can be longer.
func recordID(eventID string) string {
	if len(eventID) <= 80 {
		return eventID
	}
	sum := sha256.Sum256([]byte(eventID))
	return "h_" + hex.EncodeToString(sum[:])[:40]
}

// apply records one Google event in the state, or removes it.
func (state *roomState) apply(event googleEvent, zone *time.Location, until time.Time) {
	id := recordID(event.ID)
	start, end, allDay, ok := eventTimes(event, zone)
	if event.Status == "cancelled" || !ok || !start.Before(until) {
		delete(state.Events, id)
		return
	}
	status := "confirmed"
	if event.Status == "tentative" {
		status = "tentative"
	}
	state.Events[id] = storedEvent{Title: event.Summary, Start: start.UnixMilli(), End: end.UnixMilli(), AllDay: allDay, Status: status}
}

// prune removes ended events and keeps the stored set within its bound. A
// cut shortens the coverage, so the room reads in full again sooner.
func (state *roomState) prune(now time.Time) {
	for id, event := range state.Events {
		if time.UnixMilli(event.End).Before(now.Add(-keepPastMeetings)) {
			delete(state.Events, id)
		}
	}
	if len(state.Events) <= maxStoredEvents {
		return
	}
	ids := sortedIDs(state.Events)
	for _, id := range ids[maxStoredEvents:] {
		delete(state.Events, id)
	}
	state.Coverage = state.Events[ids[maxStoredEvents-1]].Start
}

func sortedIDs(events map[string]storedEvent) []string {
	ids := make([]string, 0, len(events))
	for id := range events {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := events[ids[i]], events[ids[j]]
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		return ids[i] < ids[j]
	})
	return ids
}

// syncGoogle brings the state up to date: incrementally with the stored
// token when it still covers the look-ahead and names the same calendar,
// otherwise, and after a 410, with one bounded full read.
func syncGoogle(ctx context.Context, client fetcher, config Config, state *roomState, now time.Time) error {
	horizon := now.Add(time.Duration(config.LookAheadDays) * 24 * time.Hour)
	full := state.SyncToken == "" || state.CalendarID != config.CalendarID || state.Connection != config.Connection ||
		time.UnixMilli(state.Coverage).Before(horizon)
	if !full {
		result, err := listEvents(ctx, client, config.Connection, config.CalendarID, state.SyncToken)
		switch {
		case errors.Is(err, errSyncTokenGone):
			full = true
		case err != nil:
			return err
		default:
			zone := location(state.TimeZone)
			for _, event := range result.Events {
				state.apply(event, zone, time.UnixMilli(state.Coverage))
			}
			// An unfinished incremental read keeps the old token and
			// reads the same changes again next time; applying a change
			// twice is harmless.
			if result.Complete && result.SyncToken != "" {
				state.SyncToken = result.SyncToken
			}
		}
	}
	if full {
		result, err := listEvents(ctx, client, config.Connection, config.CalendarID, "")
		if err != nil {
			return err
		}
		coverage := horizon.Add(coverageMargin)
		*state = roomState{CalendarID: config.CalendarID, Connection: config.Connection, TimeZone: result.TimeZone,
			Coverage: coverage.UnixMilli(), Events: map[string]storedEvent{}}
		zone := location(result.TimeZone)
		for _, event := range result.Events {
			state.apply(event, zone, coverage)
		}
		if result.Complete {
			state.SyncToken = result.SyncToken
		}
	}
	state.prune(now)
	return nil
}

func location(name string) *time.Location {
	if name == "" {
		return time.UTC
	}
	zone, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return zone
}

// records are the feed records of the state: meetings that have not ended
// and start before the look-ahead ends, in start order.
func (state roomState) records(config Config, now time.Time) []plugin.FeedRecord {
	horizon := now.Add(time.Duration(config.LookAheadDays) * 24 * time.Hour)
	out := []plugin.FeedRecord{}
	for _, id := range sortedIDs(state.Events) {
		event := state.Events[id]
		start, end := time.UnixMilli(event.Start), time.UnixMilli(event.End)
		if !end.After(now) || !start.Before(horizon) {
			continue
		}
		title := event.Title
		if !config.ShowTitles || title == "" {
			title = "Busy"
		}
		if len([]rune(title)) > 200 {
			title = string([]rune(title)[:200])
		}
		out = append(out, plugin.FeedRecord{ID: id, Values: map[string]any{
			"title": title, "start": start.UTC().Format(time.RFC3339), "end": end.UTC().Format(time.RFC3339),
			"allDay": event.AllDay, "status": event.Status,
		}})
		if len(out) == maxPublished {
			break
		}
	}
	return out
}

func decodeState(raw []byte) (roomState, bool) {
	var state roomState
	if len(raw) == 0 || json.Unmarshal(raw, &state) != nil {
		return roomState{Events: map[string]storedEvent{}}, false
	}
	if state.Events == nil {
		state.Events = map[string]storedEvent{}
	}
	return state, true
}

// encodeState encodes the state within one KV value, dropping the latest
// events when a very busy room would not fit.
func encodeState(state roomState) ([]byte, error) {
	for {
		encoded, err := json.Marshal(state)
		if err != nil || len(encoded) <= plugin.MaxKVValueBytes || len(state.Events) == 0 {
			return encoded, err
		}
		ids := sortedIDs(state.Events)
		last := ids[len(ids)-1]
		state.Coverage = state.Events[last].Start
		delete(state.Events, last)
	}
}
