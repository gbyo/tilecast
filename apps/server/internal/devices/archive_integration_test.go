package devices

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestRevokedScreenArchiveDoesNotAffectLiveConfiguration(t *testing.T) {
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
	owner, err := authService.Setup(ctx, auth.SetupInput{
		OrganizationName: "Archive Test",
		OwnerName:        "Owner",
		Username:         "owner",
		Password:         "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, NewPresenceHub(), "https://signage.example.org")
	identity, err := service.Identity(ctx)
	if err != nil {
		t.Fatal(err)
	}
	location, err := service.CreateLocation(ctx, owner.User.ID, LocationInput{Name: "Old building"})
	if err != nil {
		t.Fatal(err)
	}
	metadata := DeviceMetadata{
		PlayerInstallationID: uuid.NewString(),
		Platform:             "linux",
		Manufacturer:         "Tilecast",
		Model:                "Test player",
		AndroidVersion:       "n/a",
		PlayerVersion:        "1.0.0",
		ScreenWidth:          1920,
		ScreenHeight:         1080,
		Density:              1,
		Locale:               "en-US",
		Timezone:             "America/New_York",
	}

	pairing, err := service.CreatePairing(ctx, identity.InstallationID, metadata)
	if err != nil {
		t.Fatal(err)
	}
	screen, err := service.ApprovePairing(ctx, pairing.ID, owner.User.ID, "Retired display", &location.ID, "Lobby", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := service.PollPairing(ctx, pairing.ID, pairing.PollSecret)
	if err != nil {
		t.Fatal(err)
	}
	enrollment, err := service.Enroll(ctx, pairing.ID, claim.EnrollmentToken)
	if err != nil {
		t.Fatal(err)
	}

	playlistID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,created_by) SELECT $1,id,'Archive assignment',$2 FROM organization_settings WHERE singleton=TRUE`, playlistID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by) VALUES($1,$2,$3,$4)`, uuid.New(), screen.ID, playlistID, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	if err := service.Revoke(ctx, screen.ID, owner.User.ID, "Player was replaced"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AuthenticateDevice(ctx, enrollment.DeviceCredential); !errors.Is(err, ErrRevokedCredential) {
		t.Fatalf("expected revoked credential rejection, got %v", err)
	}
	active, err := service.ListScreens(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 0 {
		t.Fatalf("archived screen remained active: %#v", active)
	}
	archived, err := service.ListArchivedScreens(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(archived) != 1 || archived[0].ID != screen.ID || archived[0].ArchivedAt == nil || archived[0].ArchivedReason != "Player was replaced" {
		t.Fatalf("archive result=%#v", archived)
	}
	if archived[0].LocationID != nil {
		t.Fatalf("archived screen retained location: %#v", archived[0].LocationID)
	}
	locations, err := service.ListLocations(ctx, authz.ScreenAccess{All: true, Configured: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(locations) != 1 || locations[0].ScreenCount != 0 {
		t.Fatalf("archived screen affected location count: %#v", locations)
	}
	var assignments int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM screen_playlist_assignments WHERE screen_id=$1`, screen.ID).Scan(&assignments); err != nil || assignments != 0 {
		t.Fatalf("archived assignment count=%d err=%v", assignments, err)
	}
	if err := service.DeleteLocation(ctx, location.ID, owner.User.ID); err != nil {
		t.Fatalf("delete location referenced only by archived screen: %v", err)
	}

	_, err = pool.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by) VALUES($1,$2,$3,$4)`, uuid.New(), screen.ID, playlistID, owner.User.ID)
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "23514" {
		t.Fatalf("expected archived assignment rejection, got %v", err)
	}

	repair, err := service.CreatePairing(ctx, identity.InstallationID, metadata)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := service.ApprovePairing(ctx, repair.ID, owner.User.ID, "Replacement display", nil, "", "", "", false)
	if err != nil || restored.ID != screen.ID {
		t.Fatalf("restore approval=%#v err=%v", restored, err)
	}
	repairClaim, err := service.PollPairing(ctx, repair.ID, repair.PollSecret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Enroll(ctx, repair.ID, repairClaim.EnrollmentToken); err != nil {
		t.Fatal(err)
	}
	archived, err = service.ListArchivedScreens(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(archived) != 0 {
		t.Fatalf("re-enrolled screen remained archived: %#v", archived)
	}
	active, err = service.ListScreens(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 1 || active[0].ID != screen.ID || active[0].Name != "Replacement display" {
		t.Fatalf("restored active screen=%#v", active)
	}
}
