package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// The Google Calendar events.list client. Every request goes through
// http.fetch@1 on the room's oauth2 connection: the host adds the bearer
// token, and this code never sees it.

// Google bounds. A full sync reads at most maxPages pages of maxResults
// events; a calendar with more is synced again in full later instead of
// incrementally.
const (
	maxResults = 2500
	maxPages   = 8
)

// errSyncTokenGone is Google's 410: the sync token is no longer valid.
var errSyncTokenGone = errors.New("google: the sync token is no longer valid")

// googleError is a Google answer other than 200 or 410.
type googleError struct{ Status int }

func (e *googleError) Error() string { return fmt.Sprintf("google: status %d", e.Status) }

type googleTime struct {
	DateTime string `json:"dateTime"`
	Date     string `json:"date"`
}

type googleEvent struct {
	ID      string     `json:"id"`
	Status  string     `json:"status"`
	Summary string     `json:"summary"`
	Start   googleTime `json:"start"`
	End     googleTime `json:"end"`
}

type googlePage struct {
	Items         []googleEvent `json:"items"`
	NextPageToken string        `json:"nextPageToken"`
	NextSyncToken string        `json:"nextSyncToken"`
	TimeZone      string        `json:"timeZone"`
}

// googleResult is one full or incremental read.
type googleResult struct {
	Events    []googleEvent
	SyncToken string
	TimeZone  string
	// Complete is false when the page bound stopped a read before its end.
	Complete bool
}

type fetcher interface {
	Fetch(ctx context.Context, request plugin.HTTPRequest) (plugin.HTTPResponse, error)
}

// listEvents reads events. With a sync token it reads the changes since
// that token; without one it reads the whole calendar. The query is the
// same in both cases except for the token, as Google requires: a sync
// token cannot be combined with timeMin or timeMax.
func listEvents(ctx context.Context, client fetcher, connection uuid.UUID, calendarID, syncToken string) (googleResult, error) {
	result := googleResult{}
	pageToken := ""
	for page := 0; page < maxPages; page++ {
		query := url.Values{"singleEvents": {"true"}, "maxResults": {fmt.Sprint(maxResults)}}
		if syncToken != "" {
			query.Set("syncToken", syncToken)
		}
		if pageToken != "" {
			query.Set("pageToken", pageToken)
		}
		response, err := client.Fetch(ctx, plugin.HTTPRequest{Connection: connection, Method: http.MethodGet,
			URL: "/calendar/v3/calendars/" + url.PathEscape(calendarID) + "/events?" + query.Encode()})
		if err != nil {
			return googleResult{}, err
		}
		switch response.Status {
		case http.StatusOK:
		case http.StatusGone:
			return googleResult{}, errSyncTokenGone
		default:
			return googleResult{}, &googleError{Status: response.Status}
		}
		var body googlePage
		if err := json.Unmarshal(response.Body, &body); err != nil {
			return googleResult{}, fmt.Errorf("google: decode events: %w", err)
		}
		result.Events = append(result.Events, body.Items...)
		if body.TimeZone != "" {
			result.TimeZone = body.TimeZone
		}
		if body.NextPageToken == "" {
			result.SyncToken, result.Complete = body.NextSyncToken, true
			return result, nil
		}
		pageToken = body.NextPageToken
	}
	return result, nil
}

// eventTimes turns Google's start and end into instants. An all-day event
// has dates; it starts and ends at local midnight in the calendar's zone.
func eventTimes(event googleEvent, zone *time.Location) (start, end time.Time, allDay, ok bool) {
	parse := func(value googleTime) (time.Time, bool, bool) {
		if value.DateTime != "" {
			at, err := time.Parse(time.RFC3339, value.DateTime)
			return at, false, err == nil
		}
		if value.Date != "" {
			at, err := time.ParseInLocation("2006-01-02", value.Date, zone)
			return at, true, err == nil
		}
		return time.Time{}, false, false
	}
	start, allDay, okStart := parse(event.Start)
	end, _, okEnd := parse(event.End)
	return start, end, allDay, okStart && okEnd && end.After(start)
}
