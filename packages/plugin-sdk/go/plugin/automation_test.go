package plugin

import (
	"os"
	"path/filepath"
	"testing"
)

// The countdown-bar automation document is the worked example: it must
// keep parsing under the same rules the host enforces.
func TestParseAutomationCountdownBar(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugins", "countdown-bar", "automation.gen.json"))
	if err != nil {
		t.Skipf("generated automation document is not present: %v", err)
	}
	document, err := ParseAutomation(data)
	if err != nil {
		t.Fatalf("ParseAutomation: %v", err)
	}
	if document.Plugin != "countdown_bar" {
		t.Fatalf("Plugin = %q, want countdown_bar", document.Plugin)
	}
	if len(document.Operations) != 5 {
		t.Fatalf("len(Operations) = %d, want 5", len(document.Operations))
	}
}

func TestParseAutomationRejects(t *testing.T) {
	cases := map[string]string{
		"bad version":   `{"apiVersion":2,"plugin":"x","operations":[{"operationId":"a","method":"get","path":"/p","risk":"read","cliPath":["a"],"mcpAction":"a"}]}`,
		"no operations": `{"apiVersion":1,"plugin":"x","operations":[]}`,
		"bad method":    `{"apiVersion":1,"plugin":"x","operations":[{"operationId":"a","method":"subscribe","path":"/p","risk":"read","cliPath":["a"],"mcpAction":"a"}]}`,
		"bad risk":      `{"apiVersion":1,"plugin":"x","operations":[{"operationId":"a","method":"get","path":"/p","risk":"break-glass","cliPath":["a"],"mcpAction":"a"}]}`,
		"duplicate":     `{"apiVersion":1,"plugin":"x","operations":[{"operationId":"a","method":"get","path":"/p","risk":"read","cliPath":["a"],"mcpAction":"a"},{"operationId":"a","method":"get","path":"/q","risk":"read","cliPath":["b"],"mcpAction":"b"}]}`,
		"overlap":       `{"apiVersion":1,"plugin":"x","operations":[{"operationId":"a","method":"get","path":"/p","risk":"read","cliPath":["a"],"mcpAction":"a"}],"exclusions":[{"operationId":"a","reason":"stays out because reasons"}]}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseAutomation([]byte(raw)); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}
