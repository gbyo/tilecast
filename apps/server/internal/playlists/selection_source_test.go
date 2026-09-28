package playlists

import "testing"

func TestCanonicalSelectionSourceUsesTheSharedVocabulary(t *testing.T) {
	for source, want := range map[string]string{
		"": "", "takeover": "takeover", "quick_present": "quick_present", "schedule": "schedule",
		"direct_fallback": "direct_fallback", "none": "none",
		// The Linux player's name for a direct assignment.
		"direct": "direct_fallback",
	} {
		got, ok := canonicalSelectionSource(source)
		if !ok || got != want {
			t.Errorf("%q: got %q, %v; want %q", source, got, ok, want)
		}
	}
	for _, source := range []string{"emergency", "Quick Present", "quick_present ", "schedule;drop"} {
		if _, ok := canonicalSelectionSource(source); ok {
			t.Errorf("%q should be refused", source)
		}
	}
}
