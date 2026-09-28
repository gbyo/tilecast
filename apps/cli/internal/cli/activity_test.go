package cli

import (
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
)

func activityFixture(t *testing.T) *cliFixture {
	t.Helper()
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TILECAST_TOKEN", "tcp_activity")
	return f
}

func TestActivityOverviewAndUptime(t *testing.T) {
	f := activityFixture(t)
	out, err := f.execute(t, "", "activity", "overview")
	if err != nil || !strings.Contains(out, "screens") {
		t.Fatalf("overview = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "activity", "uptime", "--window", "7d")
	if err != nil || !strings.Contains(out, "7d") || !strings.Contains(out, "99.5") {
		t.Fatalf("uptime = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "activity", "uptime", "--window", "90d"); err == nil || !strings.Contains(err.Error(), "uptime_window_invalid") {
		t.Fatalf("bad window accepted: %v", err)
	}
}

func TestActivityIncidents(t *testing.T) {
	f := activityFixture(t)
	out, err := f.execute(t, "", "activity", "incidents")
	if err != nil || !strings.Contains(out, "Lobby offline") || !strings.Contains(out, "Hall stalls") {
		t.Fatalf("incidents = %q, %v", out, err)
	}
	// Newest first: the Jan 2 incident leads.
	if strings.Index(out, "Lobby offline") > strings.Index(out, "Hall stalls") {
		t.Fatalf("incidents not newest-first: %q", out)
	}
	out, err = f.execute(t, "", "activity", "incidents", "--status", "open", "--severity", "error")
	if err != nil {
		t.Fatal(err)
	}
	if f.lastIncidentQuery != "severity=error&status=open" && f.lastIncidentQuery != "status=open&severity=error" {
		t.Fatalf("incident query = %q", f.lastIncidentQuery)
	}
	out, err = f.execute(t, "", "activity", "incident", "get", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	if err != nil || !strings.Contains(out, "title=Lobby offline") || !strings.Contains(out, "timelineEvents=2") {
		t.Fatalf("incident get = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "activity", "incident", "get", "cccccccc-cccc-cccc-cccc-cccccccccccc"); err == nil {
		t.Fatal("unknown incident accepted")
	}
}

func TestActivityCompliance(t *testing.T) {
	f := activityFixture(t)
	out, err := f.execute(t, "", "activity", "compliance")
	if err != nil || !strings.Contains(out, "expected") || !strings.Contains(out, "97") {
		t.Fatalf("compliance = %q, %v", out, err)
	}
}
