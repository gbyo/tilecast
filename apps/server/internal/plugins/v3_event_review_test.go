package plugins

import "testing"

// The install review names a publishing plugin the release includes, and
// leaves core events and unknown publishers unnamed.
func TestNamePublishers(t *testing.T) {
	definitions := []Definition{
		{ID: "bell_schedule", Name: "Bell Schedule"},
		{ID: "room_sign", Name: "Room Sign", Events: EventReview{Subscribes: []SubscribedEventReview{
			{Event: "takeover.started@1", Publisher: "core"},
			{Event: "plugin.bell_schedule.period_started@1", Publisher: "bell_schedule"},
			{Event: "plugin.gone.thing@1", Publisher: "gone"},
		}}},
	}
	namePublishers(definitions)
	got := definitions[1].Events.Subscribes
	if got[0].PublisherName != "" || got[1].PublisherName != "Bell Schedule" || got[2].PublisherName != "" {
		t.Fatalf("publisher names = %+v", got)
	}
}
