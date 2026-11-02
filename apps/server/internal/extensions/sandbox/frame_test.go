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

func TestAssembleFrameAgreesOnBytesHashAndSize(t *testing.T) {
	definition := `globalThis.__tilecastWidgetDefinition={type:"acme.ok",version:1};`
	first, err := AssembleFrame(definition)
	if err != nil {
		t.Fatalf("AssembleFrame returned error: %v", err)
	}
	second, err := AssembleFrame(definition)
	if err != nil {
		t.Fatalf("AssembleFrame returned error: %v", err)
	}
	if first != second {
		t.Fatal("AssembleFrame is not deterministic")
	}
	plain, err := Assemble(definition)
	if err != nil {
		t.Fatalf("Assemble returned error: %v", err)
	}
	if first.Document != plain {
		t.Fatal("AssembleFrame document differs from Assemble")
	}
	if int64(len(first.Document)) != first.Size {
		t.Fatalf("frame size = %d, want %d", first.Size, len(first.Document))
	}
	if len(first.SHA256Hex) != 64 {
		t.Fatalf("frame hash = %q, want 64 hex characters", first.SHA256Hex)
	}
	// The template stays far below the headroom: the bound budgets a
	// maximum-size bundle, not template growth.
	if int64(len(Template)) >= 1<<16 {
		t.Fatalf("frame template is %d bytes, want below 64KiB", len(Template))
	}
	if _, err := AssembleFrame(strings.Repeat("x", int(MaxFrameBytes))); err == nil {
		t.Fatal("AssembleFrame accepted an oversized document")
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
