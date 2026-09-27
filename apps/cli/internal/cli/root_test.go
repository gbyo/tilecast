package cli

import (
	"bytes"
	"strings"
	"testing"
)

func execute(args ...string) (string, error) {
	root := NewRootCommand()
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

func TestVersionCommand(t *testing.T) {
	out, err := execute("version")
	if err != nil {
		t.Fatalf("version: %v", err)
	}
	if !strings.HasPrefix(out, "tilecast ") {
		t.Fatalf("version output %q does not start with %q", out, "tilecast ")
	}
}

func TestVersionShortFlag(t *testing.T) {
	out, err := execute("version", "--short")
	if err != nil {
		t.Fatalf("version --short: %v", err)
	}
	if strings.TrimSpace(out) != Version {
		t.Fatalf("version --short = %q, want %q", strings.TrimSpace(out), Version)
	}
}

func TestHelpCommandExists(t *testing.T) {
	out, err := execute("help")
	if err != nil {
		t.Fatalf("help: %v", err)
	}
	if !strings.Contains(out, "version") || !strings.Contains(out, "completion") {
		t.Fatalf("help output does not list core commands:\n%s", out)
	}
}

func TestCompletionBash(t *testing.T) {
	out, err := execute("completion", "bash")
	if err != nil {
		t.Fatalf("completion bash: %v", err)
	}
	if !strings.Contains(out, "tilecast") {
		t.Fatalf("bash completion does not mention tilecast")
	}
}

func TestCompletionRejectsUnknownShell(t *testing.T) {
	if _, err := execute("completion", "tcsh"); err == nil {
		t.Fatal("completion tcsh succeeded, want an error")
	}
}

func TestUnknownCommandFails(t *testing.T) {
	if _, err := execute("serve"); err == nil {
		t.Fatal("serve succeeded, want an error: local administration belongs to tilecast-server")
	}
}
