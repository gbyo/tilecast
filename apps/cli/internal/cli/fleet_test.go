package cli

import (
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/cli/internal/config"
)

func fleetFixture(t *testing.T) *cliFixture {
	t.Helper()
	f := newFixture(t)
	if err := f.env.config.Upsert(config.Context{Name: "home", ServerURL: f.server.URL, InstallationID: "123e4567-e89b-12d3-a456-426614174000"}, true); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TILECAST_TOKEN", "tcp_fleet")
	return f
}

func TestScreenUpdatePrefills(t *testing.T) {
	f := fleetFixture(t)
	out, err := f.execute(t, "", "screen", "update", "lobby", "--name", "Front Lobby", "--yes")
	if err != nil || !strings.Contains(out, "updated Front Lobby") {
		t.Fatalf("update = %q, %v", out, err)
	}
	if f.lastScreenUpdate["name"] != "Front Lobby" {
		t.Fatalf("update body name = %v", f.lastScreenUpdate)
	}
	// Unset flags keep the values read first: the fixture screen reports
	// room Foyer, and the PATCH must carry it back.
	if f.lastScreenUpdate["roomName"] != "Foyer" || f.lastScreenUpdate["roomNumber"] != "1A" {
		t.Fatalf("update body did not prefill: %v", f.lastScreenUpdate)
	}
	if _, err := f.execute(t, "", "screen", "update", "lobby", "--yes"); err == nil || !strings.Contains(err.Error(), "nothing to update") {
		t.Fatalf("empty update accepted: %v", err)
	}
	if _, err := f.execute(t, "", "screen", "update", "lobby", "--name", "X"); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("update without --yes accepted: %v", err)
	}
}

func TestScreenDisableEnableRevoke(t *testing.T) {
	f := fleetFixture(t)
	out, err := f.execute(t, "", "screen", "disable", "11111111-1111-1111-1111-111111111111", "--yes")
	if err != nil || !strings.Contains(out, "disabled lobby") {
		t.Fatalf("disable = %q, %v", out, err)
	}
	if f.lastAutomationCall != "POST /api/v1/screens/11111111-1111-1111-1111-111111111111/disable" {
		t.Fatalf("disable called %q", f.lastAutomationCall)
	}
	out, err = f.execute(t, "", "screen", "enable", "lobby", "--yes")
	if err != nil || !strings.Contains(out, "enabled lobby") {
		t.Fatalf("enable = %q, %v", out, err)
	}
	out, err = f.execute(t, "y\n", "screen", "revoke", "lobby", "--reason", "lost remote")
	if err != nil || !strings.Contains(out, "revoked lobby") {
		t.Fatalf("revoke = %q, %v", out, err)
	}
	if f.lastAutomationCall != "POST /api/v1/screens/11111111-1111-1111-1111-111111111111/revoke" {
		t.Fatalf("revoke called %q", f.lastAutomationCall)
	}
	if _, err := f.execute(t, "", "screen", "revoke", "lobby"); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("revoke without --yes accepted: %v", err)
	}
}

func TestPairingCeremony(t *testing.T) {
	f := fleetFixture(t)
	out, err := f.execute(t, "", "pairing", "list")
	if err != nil || !strings.Contains(out, "44444444-4444-4444-4444-444444444444") {
		t.Fatalf("list = %q, %v", out, err)
	}
	out, err = f.execute(t, "", "pairing", "resolve", "ABC123")
	if err != nil || !strings.Contains(out, "session=44444444-4444-4444-4444-444444444444") || !strings.Contains(out, "pairing approve") {
		t.Fatalf("resolve = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "pairing", "resolve", "ZZZ999"); err == nil {
		t.Fatal("bad code accepted")
	}
	out, err = f.execute(t, "", "pairing", "approve", "44444444-4444-4444-4444-444444444444",
		"--name", "Kiosk", "--yes")
	if err != nil || !strings.Contains(out, "approved Kiosk") {
		t.Fatalf("approve with optional room details omitted = %q, %v", out, err)
	}
	if f.lastPairingApproval["name"] != "Kiosk" || f.lastPairingApproval["roomName"] != "" ||
		f.lastPairingApproval["roomNumber"] != "" || f.lastPairingApproval["description"] != "" {
		t.Fatalf("approve body = %v", f.lastPairingApproval)
	}
	if _, err := f.execute(t, "", "pairing", "approve", "44444444-4444-4444-4444-444444444444", "--yes"); err == nil {
		t.Fatal("ordinary approval without a name accepted")
	}
	out, err = f.execute(t, "", "pairing", "approve", "44444444-4444-4444-4444-444444444444",
		"--replace-hardware", "--replacement-screen-id", "11111111-1111-1111-1111-111111111111", "--yes")
	if err != nil {
		t.Fatalf("hardware replacement without metadata = %q, %v", out, err)
	}
	if f.lastPairingApproval["replaceHardware"] != true ||
		f.lastPairingApproval["replacementScreenId"] != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("replacement body = %v", f.lastPairingApproval)
	}
	out, err = f.execute(t, "", "pairing", "reject", "44444444-4444-4444-4444-444444444444", "--reason", "unknown device", "--yes")
	if err != nil || !strings.Contains(out, "rejected 44444444") {
		t.Fatalf("reject = %q, %v", out, err)
	}
	if _, err := f.execute(t, "", "pairing", "approve", "not-a-uuid", "--name", "Kiosk",
		"--room-name", "S", "--room-number", "3", "--description", "D"); err == nil {
		t.Fatal("approve with bad session id accepted")
	}
}
