package playlists

import (
	"testing"

	"github.com/google/uuid"
)

func TestManifestETagStableAndVersioned(t *testing.T) {
	screen := uuid.New()
	first := manifestETag(screen, 4)
	if first != manifestETag(screen, 4) {
		t.Fatal("manifest ETag is unstable")
	}
	if first == manifestETag(screen, 5) {
		t.Fatal("manifest ETag ignored the version")
	}
}

func TestManifestETagChangesWhenScheduleCrossesPrefetchHorizon(t *testing.T) {
	base := manifestETag(uuid.New(), 4)
	schedule := ManifestSchedule{ID: uuid.New()}
	withSchedule := manifestETagForSchedules(base, []ManifestSchedule{schedule})
	if withSchedule == base {
		t.Fatal("schedule set did not affect manifest ETag")
	}
	if withSchedule != manifestETagForSchedules(base, []ManifestSchedule{schedule}) {
		t.Fatal("schedule-aware manifest ETag is unstable")
	}
}

func TestDowngradeManifestCrossfadesPreservesOtherTransitions(t *testing.T) {
	direct := &ManifestPlaylist{Items: []ManifestItem{{Transition: "crossfade"}}}
	manifest := Manifest{Playlist: direct, Playlists: []ManifestPlaylist{{Items: []ManifestItem{
		{Transition: "crossfade"},
		{Transition: "fade"},
		{Transition: "none"},
	}}}}
	if !manifestHasCrossfade(manifest) {
		t.Fatal("crossfade was not detected")
	}
	downgradeManifestCrossfades(&manifest)
	got := manifest.Playlists[0].Items
	if got[0].Transition != "fade" || got[1].Transition != "fade" || got[2].Transition != "none" {
		t.Fatalf("unexpected downgraded transitions: %#v", got)
	}
	if manifest.Playlist.Items[0].Transition != "fade" {
		t.Fatalf("direct playlist was not downgraded: %#v", manifest.Playlist.Items)
	}
}

func TestNormalizeSourceType(t *testing.T) {
	for _, test := range []struct {
		name  string
		input string
		want  string
	}{
		{name: "legacy omitted value", input: "", want: "static"},
		{name: "standard playlist", input: "static", want: "static"},
		{name: "tag-driven playlist", input: "tag", want: "tag"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeSourceType(test.input)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("normalizeSourceType(%q)=%q, want %q", test.input, got, test.want)
			}
		})
	}

	if _, err := normalizeSourceType("automatic"); err == nil {
		t.Fatal("invalid source type was accepted")
	}
}

func TestValidateBulkItemInput(t *testing.T) {
	transition := "crossfade"
	invalidTransition := "dissolve"
	zeroDuration := int64(0)
	duplicateID := uuid.New()
	if err := validateBulkItemInput(BulkItemInput{Transition: &transition}); err != nil {
		t.Fatalf("valid transition update rejected: %v", err)
	}

	duration := int64(15_000)
	if err := validateBulkItemInput(BulkItemInput{DurationMS: &duration}); err != nil {
		t.Fatalf("valid duration update rejected: %v", err)
	}

	for _, test := range []struct {
		name  string
		input BulkItemInput
	}{
		{name: "no fields", input: BulkItemInput{}},
		{name: "both fields", input: BulkItemInput{Transition: &transition, DurationMS: &duration}},
		{name: "invalid transition", input: BulkItemInput{Transition: &invalidTransition}},
		{name: "invalid duration", input: BulkItemInput{DurationMS: &zeroDuration}},
		{name: "duplicate item", input: BulkItemInput{Transition: &transition, ItemIDs: []uuid.UUID{duplicateID, duplicateID}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateBulkItemInput(test.input); err == nil {
				t.Fatal("invalid bulk update was accepted")
			}
		})
	}

	itemID := uuid.New()
	if err := validateBulkItemInput(BulkItemInput{Transition: &transition, ItemIDs: []uuid.UUID{itemID}}); err != nil {
		t.Fatalf("valid item selection rejected: %v", err)
	}
}
