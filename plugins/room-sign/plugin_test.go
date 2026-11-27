package roomsign_test

import (
	"strings"
	"testing"

	roomsign "github.com/tilecast/tilecast/plugins/room-sign"
)

func TestManifestAsksForReadOnlyCalendarAccess(t *testing.T) {
	manifest := roomsign.New().Manifest()
	if err := manifest.Validate(); err != nil {
		t.Fatal(err)
	}
	google, ok := manifest.ConnectionByID("google")
	if !ok || !google.IsOAuth() || strings.Join(google.OAuth.Scopes, " ") != "https://www.googleapis.com/auth/calendar.events.readonly" ||
		google.OAuth.AuthorizationParameters["access_type"] != "offline" || google.OAuth.RevocationEndpoint == "" {
		t.Fatalf("google = %+v", google.OAuth)
	}
	feed, ok := manifest.FeedByID("events")
	if !ok || feed.ProviderID(manifest.ID) != "room_sign.events" || feed.Fields[0].Personal == nil {
		t.Fatalf("feed = %+v", feed)
	}
}
