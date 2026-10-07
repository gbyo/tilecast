package sandbox

import (
	"strings"
	"testing"
)

func TestEscapeInlineScript(t *testing.T) {
	vectors := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "plain bundle untouched",
			in:   `globalThis.__tilecastWidgetDefinition={type:"acme.ok"}`,
			want: `globalThis.__tilecastWidgetDefinition={type:"acme.ok"}`,
		},
		{
			name: "lowercase breakout",
			in:   `</script><script>fetch("https://evil.example")</script>`,
			want: `<\/script><script>fetch("https://evil.example")<\/script>`,
		},
		{
			name: "mixed case breakout",
			in:   `</ScRiPt><SCRIPT>alert(1)</SCRIPT>`,
			want: `<\/script><SCRIPT>alert(1)<\/script>`,
		},
		{
			name: "unclosed opener untouched",
			in:   `<script>var x = 1;`,
			want: `<script>var x = 1;`,
		},
	}
	for _, vector := range vectors {
		t.Run(vector.name, func(t *testing.T) {
			if got := EscapeInlineScript(vector.in); got != vector.want {
				t.Fatalf("EscapeInlineScript(%q) = %q, want %q", vector.in, got, vector.want)
			}
		})
	}
}

func TestAssemble(t *testing.T) {
	definition := `globalThis.__tilecastWidgetDefinition={type:"acme.ok",version:1};`
	document, err := Assemble(definition)
	if err != nil {
		t.Fatalf("Assemble returned error: %v", err)
	}
	if !strings.Contains(document, "tilecast.widget.bridge/1") {
		t.Fatal("assembled document is missing the bridge protocol")
	}
	bootstrap := strings.Index(document, `addEventListener("message"`)
	bundle := strings.Index(document, definition)
	if bootstrap < 0 || bundle < 0 || bootstrap > bundle {
		t.Fatal("bootstrap must precede the bundle in the assembled document")
	}
	if strings.Contains(document, BundlePlaceholder) {
		t.Fatal("assembled document still holds the bundle placeholder")
	}
}

func TestAssembleKeepsHostileBundleInsideItsBlock(t *testing.T) {
	hostile := `</script><script>fetch("https://evil.example")</script>`
	document, err := Assemble(hostile)
	if err != nil {
		t.Fatalf("Assemble returned error: %v", err)
	}
	// Exactly the two intended closers: bootstrap, then bundle.
	if got := strings.Count(document, `</script>`); got != 2 {
		t.Fatalf("assembled document holds %d script closers, want 2", got)
	}
	if !strings.Contains(document, EscapeInlineScript(hostile)) {
		t.Fatal("assembled document is missing the escaped bundle")
	}
}
