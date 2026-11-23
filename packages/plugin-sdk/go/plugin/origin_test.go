package plugin

import (
	"encoding/json"
	"os"
	"testing"
)

type originCase struct {
	Input     string  `json:"input"`
	Operator  *string `json:"operator"`
	Canonical bool    `json:"canonical"`
}

func TestOriginFixtures(t *testing.T) {
	data, err := os.ReadFile("../../testdata/origins.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Cases []originCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures.Cases {
		origin, err := ParseOrigin(fixture.Input)
		if fixture.Operator == nil {
			if err == nil {
				t.Errorf("%q: accepted as %s", fixture.Input, origin)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", fixture.Input, err)
			continue
		}
		if origin.String() != *fixture.Operator {
			t.Errorf("%q: got %s, want %s", fixture.Input, origin, *fixture.Operator)
		}
		if _, err := ParseCanonicalOrigin(fixture.Input); (err == nil) != fixture.Canonical {
			t.Errorf("%q: canonical %v, want %v", fixture.Input, err == nil, fixture.Canonical)
		}
	}
}
