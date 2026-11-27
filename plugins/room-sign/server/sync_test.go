package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// fakeGoogle answers events.list from scripted pages, keyed by sync token
// and page token, and records every request.
type fakeGoogle struct {
	pages    map[string]googlePage
	status   map[string]int
	requests []url.Values
}

func (f *fakeGoogle) Fetch(_ context.Context, request plugin.HTTPRequest) (plugin.HTTPResponse, error) {
	parsed, _ := url.Parse(request.URL)
	query := parsed.Query()
	f.requests = append(f.requests, query)
	key := query.Get("syncToken") + "|" + query.Get("pageToken")
	if status, ok := f.status[key]; ok {
		return plugin.HTTPResponse{Status: status}, nil
	}
	page, ok := f.pages[key]
	if !ok {
		return plugin.HTTPResponse{Status: http.StatusNotFound}, nil
	}
	body, _ := json.Marshal(page)
	return plugin.HTTPResponse{Status: http.StatusOK, Body: body}, nil
}

func timed(id, summary, start, end string) googleEvent {
	return googleEvent{ID: id, Status: "confirmed", Summary: summary, Start: googleTime{DateTime: start}, End: googleTime{DateTime: end}}
}

var now = time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC)

func config() Config {
	return Config{Connection: uuid.MustParse("11111111-1111-4111-8111-111111111111"), CalendarID: "board@example.org", LookAheadDays: 2, ShowTitles: true}
}

func TestFullSyncPaginatesAndKeepsTheSyncToken(t *testing.T) {
	google := &fakeGoogle{pages: map[string]googlePage{
		"|": {Items: []googleEvent{timed("a", "Planning", "2026-11-23T08:30:00Z", "2026-11-23T09:30:00Z")}, NextPageToken: "p2", TimeZone: "America/Chicago"},
		"|p2": {Items: []googleEvent{
			timed("b", "Review", "2026-11-23T11:00:00Z", "2026-11-23T12:00:00Z"),
			{ID: "c", Status: "cancelled"},
			{ID: "d", Status: "tentative", Summary: "Offsite", Start: googleTime{Date: "2026-11-24"}, End: googleTime{Date: "2026-11-25"}},
			timed("old", "Yesterday", "2026-11-22T08:00:00Z", "2026-11-22T09:00:00Z"),
			timed("far", "Next month", "2026-12-23T08:00:00Z", "2026-12-23T09:00:00Z"),
		}, NextSyncToken: "s1"},
	}}
	state := roomState{Events: map[string]storedEvent{}}
	if err := syncGoogle(context.Background(), google, config(), &state, now); err != nil {
		t.Fatal(err)
	}
	if state.SyncToken != "s1" || state.CalendarID != "board@example.org" || len(google.requests) != 2 {
		t.Fatalf("state = %+v, requests %v", state, google.requests)
	}
	for _, request := range google.requests {
		// A sync token is never combined with timeMin or timeMax, so the
		// full read uses neither either.
		if request.Get("singleEvents") != "true" || request.Has("timeMin") || request.Has("timeMax") {
			t.Fatalf("query = %v", request)
		}
	}
	records := state.records(config(), now)
	ids := []string{}
	for _, record := range records {
		ids = append(ids, record.ID)
	}
	if strings.Join(ids, ",") != "a,b,d" {
		t.Fatalf("records = %v", ids)
	}
	// An all-day event starts at local midnight in the calendar's zone.
	if records[2].Values["start"] != "2026-11-24T06:00:00Z" || records[2].Values["allDay"] != true || records[2].Values["status"] != "tentative" {
		t.Fatalf("all-day = %v", records[2].Values)
	}
}

func TestIncrementalSyncAndAnInvalidToken(t *testing.T) {
	google := &fakeGoogle{pages: map[string]googlePage{
		"|":   {Items: []googleEvent{timed("a", "Planning", "2026-11-23T10:00:00Z", "2026-11-23T11:00:00Z")}, NextSyncToken: "s1"},
		"s1|": {Items: []googleEvent{{ID: "a", Status: "cancelled"}, timed("b", "Added", "2026-11-23T13:00:00Z", "2026-11-23T14:00:00Z")}, NextSyncToken: "s2"},
	}, status: map[string]int{"s2|": http.StatusGone}}
	state := roomState{Events: map[string]storedEvent{}}
	ctx := context.Background()
	if err := syncGoogle(ctx, google, config(), &state, now); err != nil {
		t.Fatal(err)
	}
	if err := syncGoogle(ctx, google, config(), &state, now.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, gone := state.Events["a"]; gone || state.Events["b"].Title != "Added" || state.SyncToken != "s2" {
		t.Fatalf("after the change = %+v", state)
	}
	if google.requests[1].Get("syncToken") != "s1" {
		t.Fatalf("incremental query = %v", google.requests[1])
	}
	// 410: the token is dropped and one bounded full read follows.
	if err := syncGoogle(ctx, google, config(), &state, now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if state.SyncToken != "s1" || state.Events["a"].Title != "Planning" || len(state.Events) != 1 {
		t.Fatalf("after a full resync = %+v", state)
	}
	// Another calendar, or a look-ahead past the coverage, reads in full.
	other := config()
	other.CalendarID = "lobby@example.org"
	google.pages["|"] = googlePage{NextSyncToken: "x1"}
	if err := syncGoogle(ctx, google, other, &state, now); err != nil || state.SyncToken != "x1" || len(state.Events) != 0 {
		t.Fatalf("calendar change = %+v %v", state, err)
	}
	state.Coverage = now.UnixMilli()
	before := len(google.requests)
	if err := syncGoogle(ctx, google, other, &state, now); err != nil || google.requests[before].Has("syncToken") {
		t.Fatalf("expired coverage read incrementally: %v", err)
	}
}

func TestProviderErrorsAndBounds(t *testing.T) {
	google := &fakeGoogle{status: map[string]int{"|": http.StatusForbidden}}
	state := roomState{Events: map[string]storedEvent{}}
	var failure *googleError
	if err := syncGoogle(context.Background(), google, config(), &state, now); !errors.As(err, &failure) || failure.Status != http.StatusForbidden {
		t.Fatalf("403 = %v", err)
	}
	// A page bound without a sync token keeps the events and no token.
	pages := map[string]googlePage{}
	for page := 0; page < maxPages; page++ {
		key := "|"
		if page > 0 {
			key = "|p" + string(rune('0'+page))
		}
		pages[key] = googlePage{Items: []googleEvent{timed("e"+string(rune('0'+page)), "x", "2026-11-23T10:00:00Z", "2026-11-23T11:00:00Z")},
			NextPageToken: "p" + string(rune('1'+page))}
	}
	google = &fakeGoogle{pages: pages}
	if err := syncGoogle(context.Background(), google, config(), &state, now); err != nil || state.SyncToken != "" || len(state.Events) != maxPages {
		t.Fatalf("bounded read = %+v %v", state, err)
	}
	// Long recurring-instance IDs become stable 80-character record IDs.
	long := strings.Repeat("r", 120)
	if id := recordID(long); len(id) > 80 || id != recordID(long) || recordID("short") != "short" {
		t.Fatalf("record ID = %q", id)
	}
	// Private rooms show Busy.
	private := config()
	private.ShowTitles = false
	state = roomState{Events: map[string]storedEvent{"a": {Title: "Secret", Start: now.UnixMilli(), End: now.Add(time.Hour).UnixMilli()}}}
	if records := state.records(private, now); records[0].Values["title"] != "Busy" {
		t.Fatalf("private = %v", records)
	}
	// The state fits one KV value whatever Google sends.
	state = roomState{Events: map[string]storedEvent{}}
	for i := 0; i < 400; i++ {
		state.Events[uuid.NewString()] = storedEvent{Title: strings.Repeat("t", 200), Start: now.Add(time.Duration(i) * time.Minute).UnixMilli(), End: now.Add(time.Duration(i+1) * time.Minute).UnixMilli()}
	}
	state.prune(now)
	encoded, err := encodeState(state)
	if err != nil || len(encoded) > plugin.MaxKVValueBytes || len(state.Events) > maxStoredEvents {
		t.Fatalf("encoded %d bytes, %d events, %v", len(encoded), len(state.Events), err)
	}
}

func TestSampleMeetingsAndManifest(t *testing.T) {
	records := sampleRecords(now)
	if len(records) != 4 || records[0].Values["start"] != "2026-11-23T08:30:00Z" {
		t.Fatalf("sample = %v", records)
	}
}
