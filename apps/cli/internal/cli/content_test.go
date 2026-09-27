package cli

import (
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
)

func contentFixture(t *testing.T) *cliFixture {
	t.Helper()
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TILECAST_TOKEN", "tcp_content")
	return f
}

func TestPlaylistListGetPublish(t *testing.T) {
	f := contentFixture(t)
	out, err := f.execute(t, "", "playlist", "list")
	if err != nil || !strings.Contains(out, "Morning") || !strings.Contains(out, "yes") {
		t.Fatalf("list = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "playlist", "get", "66666666-6666-6666-6666-666666666666")
	if err != nil || !strings.Contains(out, "draftRevision=9") || !strings.Contains(out, "items=1") {
		t.Fatalf("get = %q, %v", out, err)
	}
	// Publish reads the draft first and carries revision 9.
	out, err = f.execute(t, "", "playlist", "publish", "66666666-6666-6666-6666-666666666666", "--yes")
	if err != nil || !strings.Contains(out, "published 66666666") {
		t.Fatalf("publish = %q, %v", out, err)
	}
	if f.lastPublishRevision != 9 {
		t.Fatalf("publish carried revision %d, want 9", f.lastPublishRevision)
	}
	// An explicit stale revision surfaces the conflict with a hint.
	_, err = f.execute(t, "", "playlist", "publish", "66666666-6666-6666-6666-666666666666", "--expected-revision", "7", "--yes")
	if err == nil || !strings.Contains(err.Error(), "draft moved") {
		t.Fatalf("stale publish accepted: %v", err)
	}
	if _, err := f.execute(t, "", "playlist", "publish", "66666666-6666-6666-6666-666666666666"); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("publish without --yes accepted: %v", err)
	}
	if _, err := f.execute(t, "", "playlist", "get", "not-a-uuid"); err == nil {
		t.Fatal("bad id accepted")
	}
}

func TestScheduleListGetCreate(t *testing.T) {
	f := contentFixture(t)
	out, err := f.execute(t, "", "schedule", "list")
	if err != nil || !strings.Contains(out, "Weekdays") {
		t.Fatalf("list = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "schedule", "get", "77777777-7777-7777-7777-777777777777")
	if err != nil || !strings.Contains(out, "Weekdays") {
		t.Fatalf("get = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "schedule", "create", "--input", `{"name":"Nights"}`)
	if err != nil || !strings.Contains(out, "created Nights (88888888") {
		t.Fatalf("create = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "schedule", "create"); err == nil || !strings.Contains(err.Error(), "--input") {
		t.Fatalf("create without document accepted: %v", err)
	}
	if _, err := f.execute(t, "", "schedule", "create", "--input", `{"targets":[]}`); err == nil {
		t.Fatal("create without name accepted")
	}
	if _, err := f.execute(t, "", "schedule", "create", "--input", `{"name":"Nights","unknown":true}`); err == nil {
		t.Fatal("unknown schedule field was silently dropped")
	}
}

func TestTokenListCreate(t *testing.T) {
	f := contentFixture(t)
	out, err := f.execute(t, "", "token", "list")
	if err != nil || !strings.Contains(out, "ci") || !strings.Contains(out, "read") {
		t.Fatalf("list = %q, %v", out, err)
	}
	// The secret prints exactly once on stdout, with the warning on stderr
	// (both streams merge in the fixture output).
	out, err = f.execute(t, "", "token", "create", "--name", "backup", "--scope", "read", "--scope", "write", "--expires-in-days", "90", "--yes")
	if err != nil || !strings.Contains(out, "token=tcp_created_secret") || !strings.Contains(out, "never shows it again") {
		t.Fatalf("create = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "token", "list")
	if err != nil || strings.Contains(out, "tcp_created_secret") {
		t.Fatalf("secret leaked into list: %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "token", "create", "--name", "x", "--scope", "bogus", "--yes"); err == nil || !strings.Contains(err.Error(), "unknown scope") {
		t.Fatalf("bad scope accepted: %v", err)
	}
	if _, err := f.execute(t, "", "token", "create", "--name", "x", "--scope", "read", "--expires-in-days", "45", "--yes"); err == nil || !strings.Contains(err.Error(), "7, 30, 90, or 365") {
		t.Fatalf("bad lifetime accepted: %v", err)
	}
	if _, err := f.execute(t, "", "token", "create", "--name", "x", "--scope", "read"); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("create without --yes accepted: %v", err)
	}
}
