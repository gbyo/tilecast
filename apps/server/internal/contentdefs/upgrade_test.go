package contentdefs

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"
)

func TestUpgradeAuthorConfigurationFollowsTheTemplate(t *testing.T) {
	catalog := MustLoad()
	for _, test := range []struct {
		provider string
		saved    string
		want     string
		consumed []string
	}{
		{
			// Legacy QR keys fill the V2 fields they fall back from and leave;
			// a key the template never reads stays for the caller to judge.
			provider: "qrcode",
			saved:    `{"value":"https://example.org","label":"example.org","errorCorrection":"high","foregroundColor":"#000000"}`,
			want:     `{"errorCorrection":"high","foregroundColor":"#000000","payload":"https://example.org","shortLabel":"example.org"}`,
			consumed: []string{"label", "value"},
		},
		{
			// A current key always wins, and the legacy key it supersedes is
			// then no fallback anyone reads, so it stays untouched.
			provider: "qrcode",
			saved:    `{"payload":"https://example.com","value":"https://example.org"}`,
			want:     `{"payload":"https://example.com","value":"https://example.org"}`,
		},
		{
			// The Table component reads legacy fields directly, so they stay.
			provider: "table",
			saved:    `{"fields":["title"],"maximumItems":7,"emptyState":"None","rowSpacing":"compact"}`,
			want:     `{"density":"compact","emptyText":"None","fields":["title"],"maximumRows":7}`,
			consumed: []string{"emptyState", "maximumItems", "rowSpacing"},
		},
		{
			// A literal default is the schema's job, not an upgrade.
			provider: "clock",
			saved:    `{"timezone":"UTC"}`,
			want:     `{"timezone":"UTC"}`,
		},
		{
			provider: "text-notice",
			saved:    `{"heading":"Hi","showHeading":false,"body":"There"}`,
			want:     `{"body":"There","heading":"Hi","showHeading":false}`,
		},
	} {
		definition, ok := catalog.Widget(test.provider)
		if !ok {
			t.Fatalf("%s is not in the catalog", test.provider)
		}
		var saved map[string]any
		if err := json.Unmarshal([]byte(test.saved), &saved); err != nil {
			t.Fatal(err)
		}
		upgraded, consumed := UpgradeAuthorConfiguration(definition, saved)
		encoded, _ := json.Marshal(upgraded)
		if string(encoded) != test.want {
			t.Errorf("%s: upgraded %s to %s, want %s", test.provider, test.saved, encoded, test.want)
		}
		sort.Strings(consumed)
		if !reflect.DeepEqual(consumed, test.consumed) && (len(consumed) > 0 || len(test.consumed) > 0) {
			t.Errorf("%s: consumed %v, want %v", test.provider, consumed, test.consumed)
		}
		if saved["value"] == nil && test.provider == "qrcode" && len(test.consumed) > 0 {
			t.Errorf("%s: the saved configuration was mutated", test.provider)
		}
	}
}

func TestTemplateReads(t *testing.T) {
	table, _ := MustLoad().Widget("table")
	reads := TemplateReads(*table.Component)
	for _, key := range []string{"fields", "maximumItems", "emptyState", "columns", "backgroundColor"} {
		if !reads[key] {
			t.Errorf("Table template read %q is missing", key)
		}
	}
	if reads["textScale"] {
		t.Error("Table template does not read textScale")
	}
}
