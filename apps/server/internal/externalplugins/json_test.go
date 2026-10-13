package externalplugins

import (
	"strings"
	"testing"
)

func TestStateStructuralAndEncodingBounds(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `true`, `{"x":1} {}`, `{"x":1e9999}`, `{"x":"` + strings.Repeat("a", MaxStateBytes) + `"}`, strings.Repeat(`{"x":`, 18) + `0` + strings.Repeat(`}`, 18)} {
		if _, err := normalizeState([]byte(raw)); err == nil {
			t.Fatalf("invalid state accepted: %.40s", raw)
		}
	}
	if _, err := normalizeState([]byte(`{"count":0,"greeting":null}`)); err != nil {
		t.Fatal(err)
	}
	// PostgreSQL's JSONB output includes spaces; canonical wire size is the
	// bound, so a persisted maximum-size valid document remains readable.
	raw := `{"x": "` + strings.Repeat("a", MaxStateBytes-8) + `"}`
	canonical, err := normalizeState([]byte(raw))
	if err != nil || len(canonical) != MaxStateBytes {
		t.Fatalf("maximum canonical state: %d %v", len(canonical), err)
	}
}
