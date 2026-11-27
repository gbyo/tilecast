package coreevents

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// shape is the JSON contract of a payload type: each member and its Go
// type, in name order.
func shape(value any) []string {
	t := reflect.TypeOf(value)
	out := []string{}
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		out = append(out, name+" "+field.Type.String())
	}
	sort.Strings(out)
	return out
}

// TestCorePayloadsAreFrozen fails when a core event payload changes under
// its published version. A changed payload is a new event version: add
// name@2 to the vocabulary and testdata/payloads.json, and keep @1.
func TestCorePayloadsAreFrozen(t *testing.T) {
	raw, err := os.ReadFile("testdata/payloads.json")
	if err != nil {
		t.Fatal(err)
	}
	var frozen map[string][]string
	if err := json.Unmarshal(raw, &frozen); err != nil {
		t.Fatal(err)
	}
	if len(frozen) != len(plugin.CoreEvents) || len(Payloads) != len(plugin.CoreEvents) {
		t.Fatalf("vocabulary %d, payloads %d, frozen %d", len(plugin.CoreEvents), len(Payloads), len(frozen))
	}
	for _, name := range plugin.CoreEvents {
		got := shape(Payloads[name])
		if !reflect.DeepEqual(got, frozen[name]) {
			t.Errorf("%s payload changed; publish a new version instead:\n got  %q\n want %q", name, got, frozen[name])
		}
	}
}

func TestPayloadsStayBounded(t *testing.T) {
	for name, payload := range Payloads {
		encoded, err := json.Marshal(payload)
		if err != nil || len(encoded) > plugin.MaxEventPayloadBytes/4 {
			t.Errorf("%s encodes to %d bytes: %v", name, len(encoded), err)
		}
	}
}
