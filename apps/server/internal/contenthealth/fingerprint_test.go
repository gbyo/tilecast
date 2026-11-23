package contenthealth

import (
	"encoding/json"
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// A fingerprint depends on the content model only: the check that reads
// it and the key order of an embedded document do not change it.
func TestFingerprintIsCanonical(t *testing.T) {
	widget := func(config string, check string) plugin.ContentItem {
		return plugin.ContentItem{Check: check, Kind: plugin.ContentKindWidgetInstance, ID: "a", ModelVersion: 1, Name: "Clock",
			Widget: &plugin.ContentWidget{Provider: "clock", ConfigVersion: 1, Configuration: json.RawMessage(config)}}
	}
	first, err := Fingerprint(widget(`{"b":1,"a":{"y":2,"x":1}}`, "lint"))
	if err != nil {
		t.Fatal(err)
	}
	second, _ := Fingerprint(widget(`{ "a": {"x":1, "y":2}, "b": 1 }`, "other"))
	if first != second || len(first) != 64 {
		t.Fatalf("%s != %s", first, second)
	}
	changed, _ := Fingerprint(widget(`{"b":2,"a":{"y":2,"x":1}}`, "lint"))
	if changed == first {
		t.Fatal("a changed configuration has the same fingerprint")
	}
}
