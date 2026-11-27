package server_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/pluginharness"
	roomsign "github.com/tilecast/tilecast/plugins/room-sign"
	"github.com/tilecast/tilecast/plugins/room-sign/server"
)

// Room Sign end to end against mock Google OAuth and Calendar servers on
// the harness's fake network. Nothing here reaches Google.

const (
	accessToken  = "ya29.mock-access-7f1c"
	refreshToken = "1//mock-refresh-93ab"
)

type mockGoogle struct {
	mu         sync.Mutex
	challenges map[string]string
	// events answers events.list by sync token ("" is a full read).
	events map[string]string
	gone   map[string]bool
	calls  []string
}

func (m *mockGoogle) token(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	form, _ := url.ParseQuery(string(body))
	m.mu.Lock()
	challenge := m.challenges[form.Get("code")]
	m.mu.Unlock()
	sum := sha256.Sum256([]byte(form.Get("code_verifier")))
	if form.Get("client_id") != "room-client.apps.example" || form.Get("client_secret") != "room-secret" ||
		base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"access_token":%q,"refresh_token":%q,"expires_in":3599,"token_type":"Bearer"}`, accessToken, refreshToken)
}

func (m *mockGoogle) calendar(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+accessToken || r.URL.Path != "/calendar/v3/calendars/board@example.org/events" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	token := r.URL.Query().Get("syncToken")
	m.mu.Lock()
	m.calls = append(m.calls, token)
	body, gone := m.events[token], m.gone[token]
	m.mu.Unlock()
	if gone {
		w.WriteHeader(http.StatusGone)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, body)
}

func page(next string, events ...string) string {
	return fmt.Sprintf(`{"timeZone":"UTC","nextSyncToken":%q,"items":[%s]}`, next, strings.Join(events, ","))
}

func event(id, summary, start, end string) string {
	return fmt.Sprintf(`{"id":%q,"status":"confirmed","summary":%q,"start":{"dateTime":%q},"end":{"dateTime":%q}}`, id, summary, start, end)
}

type meeting struct{ title, start string }

func feedRecords(t *testing.T, h *pluginharness.Harness) map[string]meeting {
	t.Helper()
	datasets := h.FeedDatasets()
	if len(datasets) != 1 {
		t.Fatalf("datasets = %+v", datasets)
	}
	var payload struct {
		Datasets []struct {
			Records []struct {
				ID     string            `json:"id"`
				Values map[string]string `json:"values"`
			} `json:"records"`
		} `json:"datasets"`
	}
	if err := json.Unmarshal(h.DataSourcePayload(datasets[0].ID), &payload); err != nil {
		t.Fatal(err)
	}
	out := map[string]meeting{}
	for _, record := range payload.Datasets[0].Records {
		out[record.ID] = meeting{title: record.Values["title"], start: record.Values["start"]}
	}
	return out
}

func TestRoomSignEndToEnd(t *testing.T) {
	google := &mockGoogle{challenges: map[string]string{}, gone: map[string]bool{}, events: map[string]string{
		"": page("s1", event("planning", "Planning", "2026-11-23T08:30:00Z", "2026-11-23T09:30:00Z"),
			event("review", "Budget review", "2026-11-23T11:00:00Z", "2026-11-23T12:00:00Z")),
		"s1": page("s2", `{"id":"planning","status":"cancelled"}`, event("standup", "Standup", "2026-11-23T09:10:00Z", "2026-11-23T09:20:00Z")),
	}}
	network := pluginharness.NewFakeNetwork(t, "accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com")
	network.Serve("oauth2.googleapis.com", http.HandlerFunc(google.token))
	network.Serve("www.googleapis.com", http.HandlerFunc(google.calendar))
	clock := pluginharness.NewClock(time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC))
	plugin := roomsign.New().(*server.Plugin)
	plugin.Now = clock.Now
	h := pluginharness.New(t, plugin, pluginharness.Network(network), pluginharness.Clock(clock))
	h.Install()

	connection := h.CreateConnection("google", "Facilities Google", "room-client.apps.example", "room-secret")
	if err := h.ConnectOAuth(connection, func(authorization *url.URL) string {
		query := authorization.Query()
		if authorization.Host != "accounts.google.com" || query.Get("scope") != "https://www.googleapis.com/auth/calendar.events.readonly" ||
			query.Get("access_type") != "offline" || query.Get("prompt") != "consent" || query.Get("code_challenge_method") != "S256" {
			t.Fatalf("authorization = %s", authorization)
		}
		google.mu.Lock()
		defer google.mu.Unlock()
		google.challenges["code-1"] = query.Get("code_challenge")
		return "code-1"
	}); err != nil {
		t.Fatalf("connect = %v", err)
	}
	created := h.Serve("owner", http.MethodPost, "/plugins/room-sign/rooms", fmt.Sprintf(
		`{"name":"Board Room","enabled":true,"connection":%q,"calendarId":"board@example.org","lookAheadDays":2,"showTitles":true,"sample":false}`, connection))
	if created.Status != http.StatusCreated {
		t.Fatalf("create room = %d %v", created.Status, created.Body)
	}
	room := created.Data()["id"].(string)
	// The save asked for an early tick; the tick schedules the room's sync.
	clock.Advance(3 * time.Second)
	if h.RunTimers() != 1 || h.RunTimers() != 1 {
		t.Fatal("tick and sync did not run")
	}
	records := feedRecords(t, h)
	if records["planning"].title != "Planning" || records["review"].title != "Budget review" || len(records) != 2 {
		t.Fatalf("first publication = %+v", records)
	}
	if state := string(h.KV("room:" + room)); !strings.Contains(state, `"syncToken":"s1"`) {
		t.Fatalf("stored state = %s", state)
	}
	// Five minutes later: an incremental read cancels one meeting and adds
	// another.
	clock.Advance(5 * time.Minute)
	h.RunTimers()
	h.RunTimers()
	records = feedRecords(t, h)
	if _, kept := records["planning"]; kept || records["standup"].title != "Standup" || !strings.Contains(string(h.KV("room:"+room)), `"syncToken":"s2"`) {
		t.Fatalf("after the incremental read = %+v", records)
	}
	// Google no longer accepts s2: the room reads in full again.
	google.mu.Lock()
	google.gone["s2"] = true
	google.events[""] = page("s3", event("review", "Budget review", "2026-11-23T11:00:00Z", "2026-11-23T12:00:00Z"))
	google.mu.Unlock()
	clock.Advance(5 * time.Minute)
	h.RunTimers()
	h.RunTimers()
	records = feedRecords(t, h)
	if len(records) != 1 || records["review"].title != "Budget review" || !strings.Contains(string(h.KV("room:"+room)), `"syncToken":"s3"`) {
		t.Fatalf("after recovery = %+v", records)
	}
	google.mu.Lock()
	calls := strings.Join(google.calls, ",")
	google.mu.Unlock()
	if calls != ",s1,s2," {
		t.Fatalf("Google reads = %q", calls)
	}
	// The feed is an ordinary Data Source; no OAuth token reaches a screen,
	// the plugin's stored state, or the feed.
	detail, err := h.Media.GetDataSourceDetail(h.Ctx, h.FeedDatasets()[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	screen := h.Screen("Board Room door")
	dumps := []any{h.Manifest(screen), h.PlayerState(screen), detail, string(h.KV("room:" + room)), string(h.DataSourcePayload(h.FeedDatasets()[0].ID))}
	for _, dump := range dumps {
		encoded, _ := json.Marshal(dump)
		if strings.Contains(string(encoded), accessToken) || strings.Contains(string(encoded), refreshToken) {
			t.Fatalf("a token reached %s", encoded)
		}
	}
	if !strings.Contains(fmt.Sprint(detail), "room_sign.events") {
		t.Fatalf("detail = %+v", detail)
	}
}

func TestRoomSignSampleMeetingsNeedNoGoogle(t *testing.T) {
	clock := pluginharness.NewClock(time.Date(2026, 11, 23, 9, 15, 0, 0, time.UTC))
	plugin := roomsign.New().(*server.Plugin)
	plugin.Now = clock.Now
	h := pluginharness.New(t, plugin, pluginharness.Clock(clock))
	h.Install()
	if r := h.Serve("owner", http.MethodPost, "/plugins/room-sign/rooms", `{"name":"Lobby","enabled":true,"calendarId":"","lookAheadDays":2,"showTitles":true,"sample":false}`); r.Status != http.StatusBadRequest {
		t.Fatalf("a room without a calendar = %d %v", r.Status, r.Body)
	}
	if r := h.Serve("owner", http.MethodPost, "/plugins/room-sign/rooms", `{"name":"Lobby","enabled":true,"calendarId":"","lookAheadDays":2,"showTitles":true,"sample":true}`); r.Status != http.StatusCreated {
		t.Fatalf("a sample room = %d %v", r.Status, r.Body)
	}
	clock.Advance(3 * time.Second)
	h.RunTimers()
	h.RunTimers()
	records := feedRecords(t, h)
	if records["sample-1"].title != "Weekly planning" || len(records) != 4 {
		t.Fatalf("sample = %+v", records)
	}
}
