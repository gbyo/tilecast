package updates

import (
	"encoding/json"
	"os"
	"testing"
)

type versionFixture struct {
	CutoverCoreCode int64 `json:"cutoverCoreCode"`
	MaximumCode     int64 `json:"maximumCode"`
	Codes           []struct {
		Name string `json:"name"`
		Code int64  `json:"code"`
	} `json:"codes"`
	Invalid  []string `json:"invalid"`
	Ordered  []string `json:"ordered"`
	Channels []struct {
		Name    string  `json:"name"`
		Channel *string `json:"channel"`
	} `json:"channels"`
}

func loadVersionFixture(t *testing.T) versionFixture {
	t.Helper()
	raw, err := os.ReadFile("../../../../packages/player-contracts/fixtures/release-versions.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture versionFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestVersionCodesMatchTheSharedCorpus(t *testing.T) {
	fixture := loadVersionFixture(t)
	if fixture.CutoverCoreCode != UnifiedCutoverCoreCode || fixture.MaximumCode != MaximumVersionCode {
		t.Fatalf("fixture constants drifted: %+v", fixture)
	}
	for _, test := range fixture.Codes {
		if got, ok := VersionCode(test.Name); !ok || got != test.Code {
			t.Errorf("%q: got %d %v, want %d", test.Name, got, ok, test.Code)
		}
	}
	for _, name := range fixture.Invalid {
		if got, ok := VersionCode(name); ok {
			t.Errorf("%q accepted with code %d", name, got)
		}
	}
	for _, test := range fixture.Channels {
		want := ""
		if test.Channel != nil {
			want = *test.Channel
		}
		if got := VersionChannel(test.Name); got != want {
			t.Errorf("%q: channel %q, want %q", test.Name, got, want)
		}
	}
}

// Beta 1, Beta 2, and Stable of one version, then the next version, must
// strictly increase: the property the old scheme lacked, where a Beta and its
// Stable shared one code and Stable could never replace the Beta.
func TestVersionCodesStrictlyIncrease(t *testing.T) {
	fixture := loadVersionFixture(t)
	var previous int64 = -1
	for _, name := range fixture.Ordered {
		code, ok := VersionCode(name)
		if !ok {
			t.Fatalf("%q is invalid", name)
		}
		if code <= previous {
			t.Fatalf("%q has code %d, not above %d", name, code, previous)
		}
		if code > MaximumVersionCode {
			t.Fatalf("%q has code %d above the Android ceiling", name, code)
		}
		previous = code
	}
}

// Every unified code must exceed every code that shipped before the unified
// release, or a screen already on the old line could never be updated.
func TestUnifiedCodesExceedEveryShippedCode(t *testing.T) {
	shipped := []string{"0.25.0", "0.17.0", "0.2.1-preview.1", "0.25.999"}
	first, _ := VersionCode("0.26.0-beta.1")
	for _, name := range shipped {
		code, ok := VersionCode(name)
		if !ok || code >= first {
			t.Fatalf("%q has code %d, not below the first unified code %d", name, code, first)
		}
	}
	if androidShipped := int64(46); androidShipped >= first {
		t.Fatal("the shipped Android versionCode is not below the first unified code")
	}
}
