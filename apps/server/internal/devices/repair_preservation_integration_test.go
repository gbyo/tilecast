package devices

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// Credential repair is the same player installation, the same logical screen,
// and a new device credential. It must preserve the logical screen's metadata
// while refreshing the physical metadata the player reports.
func TestCredentialRepairPreservesLogicalScreen(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE device_pairing_sessions,device_credentials,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}

	authService := auth.NewService(pool, time.Hour)
	owner, err := authService.Setup(ctx, auth.SetupInput{OrganizationName: "Repair Library", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, NewPresenceHub(), "https://signage.example.org")
	identity, err := service.Identity(ctx)
	if err != nil || identity.InstallationID == "" {
		t.Fatalf("identity: %#v %v", identity, err)
	}

	locationID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO locations(id,organization_id,name,address_line_1,city) SELECT $1,id,'Main Building','1 Library Way','Springfield' FROM organization_settings WHERE singleton=TRUE`, locationID); err != nil {
		t.Fatal(err)
	}

	installation := uuid.NewString()
	original := DeviceMetadata{
		PlayerInstallationID: installation, Platform: "android-tv", Manufacturer: "Google", Model: "ADT-3",
		AndroidVersion: "14", PlayerVersion: "0.2.0", ScreenWidth: 1920, ScreenHeight: 1080, Density: 2,
		Locale: "en-US", Timezone: "America/New_York", ApproximateAddress: "192.168.1.42",
	}
	pairing, err := service.CreatePairing(ctx, identity.InstallationID, original)
	if err != nil {
		t.Fatal(err)
	}
	assertApprovalURL(t, pairing.ApprovalURL, pairing.Code, identity.InstallationID, "https://signage.example.org", pairing.PollSecret)

	screen, err := service.ApprovePairing(ctx, pairing.ID, owner.User.ID, "Lobby Display", &locationID, "Lobby", "101", "Main entrance", false)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := service.PollPairing(ctx, pairing.ID, pairing.PollSecret)
	if err != nil || claim.EnrollmentToken == "" {
		t.Fatalf("claim: %#v %v", claim, err)
	}
	enrollment, err := service.Enroll(ctx, pairing.ID, claim.EnrollmentToken)
	if err != nil {
		t.Fatal(err)
	}

	playlistID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,created_by) SELECT $1,id,'Lobby reel',$2 FROM organization_settings WHERE singleton=TRUE`, playlistID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by) VALUES($1,$2,$3,$4)`, uuid.New(), screen.ID, playlistID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	groupID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by) SELECT $1,id,'Entrances',$2 FROM organization_settings WHERE singleton=TRUE`, groupID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, groupID, screen.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	updated := original
	updated.PlayerVersion = "0.3.0"
	updated.ScreenWidth = 3840
	updated.ScreenHeight = 2160
	updated.Locale = "fr-FR"
	updated.Timezone = "Europe/Paris"
	repair, err := service.CreatePairing(ctx, identity.InstallationID, updated)
	if err != nil {
		t.Fatal(err)
	}
	assertApprovalURL(t, repair.ApprovalURL, repair.Code, identity.InstallationID, "https://signage.example.org", repair.PollSecret)

	// The approval still carries the contract's logical fields, but on the
	// repair branch they must not be written back to the existing screen.
	repaired, err := service.ApprovePairing(ctx, repair.ID, owner.User.ID, "Evil Rename", nil, "", "", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if repaired.ID != screen.ID {
		t.Fatalf("repair created a new screen: %s, want %s", repaired.ID, screen.ID)
	}
	var mode string
	if err := pool.QueryRow(ctx, `SELECT pairing_mode FROM device_pairing_sessions WHERE id=$1`, repair.ID).Scan(&mode); err != nil || mode != "credential_repair" {
		t.Fatalf("pairing mode=%q err=%v", mode, err)
	}
	if repaired.Name != "Lobby Display" || repaired.Description != "Main entrance" || repaired.RoomName != "Lobby" || repaired.RoomNumber != "101" {
		t.Fatalf("logical metadata was rewritten: %#v", repaired)
	}
	if repaired.LocationID == nil || *repaired.LocationID != locationID {
		t.Fatalf("location was rewritten: %#v", repaired.LocationID)
	}
	if repaired.PlayerVersion != "0.3.0" || repaired.ScreenWidth != 3840 || repaired.ScreenHeight != 2160 || repaired.Locale != "fr-FR" || repaired.Timezone != "Europe/Paris" {
		t.Fatalf("physical metadata was not refreshed: %#v", repaired)
	}
	var assignedPlaylist uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT playlist_id FROM screen_playlist_assignments WHERE screen_id=$1`, screen.ID).Scan(&assignedPlaylist); err != nil || assignedPlaylist != playlistID {
		t.Fatalf("assignment playlist=%s err=%v", assignedPlaylist, err)
	}
	var memberships int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM screen_group_memberships WHERE screen_id=$1 AND screen_group_id=$2`, screen.ID, groupID).Scan(&memberships); err != nil || memberships != 1 {
		t.Fatalf("group memberships=%d err=%v", memberships, err)
	}

	if _, err := service.AuthenticateDevice(ctx, enrollment.DeviceCredential); err != nil {
		t.Fatalf("old credential was revoked before enrollment: %v", err)
	}
	repairClaim, err := service.PollPairing(ctx, repair.ID, repair.PollSecret)
	if err != nil || repairClaim.EnrollmentToken == "" {
		t.Fatalf("repair claim=%#v err=%v", repairClaim, err)
	}
	repairEnrollment, err := service.Enroll(ctx, repair.ID, repairClaim.EnrollmentToken)
	if err != nil || repairEnrollment.ScreenID != screen.ID {
		t.Fatalf("repair enrollment=%#v err=%v", repairEnrollment, err)
	}
	if _, err := service.AuthenticateDevice(ctx, enrollment.DeviceCredential); !errors.Is(err, ErrRevokedCredential) {
		t.Fatalf("old credential still valid after repair enrollment: %v", err)
	}
	if _, err := service.AuthenticateDevice(ctx, repairEnrollment.DeviceCredential); err != nil {
		t.Fatalf("new credential invalid: %v", err)
	}
}

func assertApprovalURL(t *testing.T, approvalURL, code, installationID, publicURL, pollSecret string) {
	t.Helper()
	want := publicURL + "/screens/pair/" + code + "?installation=" + installationID
	if approvalURL != want {
		t.Fatalf("approval URL=%q want %q", approvalURL, want)
	}
	if strings.Contains(approvalURL, pollSecret) {
		t.Fatal("approval URL contains the private poll secret")
	}
}
