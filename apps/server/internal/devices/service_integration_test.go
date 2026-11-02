package devices

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestCompletePairingCredentialAndRevocationFlow(t *testing.T) {
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
	owner, err := authService.Setup(ctx, auth.SetupInput{OrganizationName: "Pairing Library", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	presence := NewPresenceHub()
	service := NewService(pool, presence, "https://signage.example.org")
	identity, err := service.Identity(ctx)
	if err != nil || identity.InstallationID == "" || identity.OrganizationName != "Pairing Library" {
		t.Fatalf("identity: %#v %v", identity, err)
	}
	metadata := DeviceMetadata{
		PlayerInstallationID: uuid.NewString(), Platform: "android-tv", Manufacturer: "Google", Model: "ADT-3",
		AndroidVersion: "14", PlayerVersion: "0.2.0", ScreenWidth: 1920, ScreenHeight: 1080, Density: 2,
		Locale: "en-US", Timezone: "America/New_York", ApproximateAddress: "192.168.1.42",
	}
	if _, err := service.CreatePairing(ctx, "wrong-installation", metadata); !errors.Is(err, ErrWrongInstallation) {
		t.Fatalf("expected installation mismatch, got %v", err)
	}
	pairing, err := service.CreatePairing(ctx, identity.InstallationID, metadata)
	if err != nil {
		t.Fatal(err)
	}
	if pairing.ServerTime.IsZero() || pairing.ExpiresAt.Sub(pairing.ServerTime) != PairingLifetime {
		t.Fatalf("pairing clock data is invalid: %#v", pairing)
	}
	resolved, err := service.ResolvePairing(ctx, pairing.Code)
	if err != nil || resolved.ID != pairing.ID || resolved.Metadata.Model != metadata.Model {
		t.Fatalf("resolve: %#v %v", resolved, err)
	}
	if _, err := service.PollPairing(ctx, pairing.ID, "wrong-secret"); !errors.Is(err, ErrWrongSecret) {
		t.Fatalf("expected wrong poll secret, got %v", err)
	}
	screen, err := service.ApprovePairing(ctx, pairing.ID, owner.User.ID, "Lobby display", nil, "Main lobby", "", "Welcome screen", false)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := service.PollPairing(ctx, pairing.ID, pairing.PollSecret)
	if err != nil || claim.Status != "claimed" || claim.EnrollmentToken == "" {
		t.Fatalf("claim: %#v %v", claim, err)
	}
	secondPoll, err := service.PollPairing(ctx, pairing.ID, pairing.PollSecret)
	if err != nil || secondPoll.EnrollmentToken != "" {
		t.Fatalf("poll secret returned token twice: %#v %v", secondPoll, err)
	}
	enrollment, err := service.Enroll(ctx, pairing.ID, claim.EnrollmentToken)
	if err != nil || enrollment.ScreenID != screen.ID || enrollment.DeviceCredential == "" {
		t.Fatalf("enroll: %#v %v", enrollment, err)
	}
	if _, err := service.Enroll(ctx, pairing.ID, claim.EnrollmentToken); !errors.Is(err, ErrAlreadyClaimed) {
		t.Fatalf("expected duplicate enrollment rejection, got %v", err)
	}
	principal, err := service.AuthenticateDevice(ctx, enrollment.DeviceCredential)
	if err != nil || principal.ScreenID != screen.ID {
		t.Fatalf("authenticate: %#v %v", principal, err)
	}
	storage := int64(4_000_000_000)
	uptime := int64(600)
	if err := service.Heartbeat(ctx, principal, Heartbeat{ScreenWidth: 1920, ScreenHeight: 1080, AvailableStorageBytes: &storage, UptimeSeconds: &uptime, PlayerVersion: "0.2.0"}, "192.168.1.42:1234"); err != nil {
		t.Fatal(err)
	}
	// Full reports, reduced socket reports, and explicit empty capability
	// reports must remain distinct across an installation upgrade.
	assertPresentationCapabilities := func(wantVersion, wantRuntime, wantCapabilities int, wantBytes int64) {
		t.Helper()
		var versions []int
		var runtime, capabilityCount int
		var bundleBytes int64
		err := pool.QueryRow(ctx, `SELECT presentation_schema_versions,web_runtime_version,web_bundle_limit_bytes,(SELECT count(*) FROM jsonb_object_keys(native_presentation_capabilities)) FROM screen_player_status WHERE screen_id=$1`, screen.ID).Scan(&versions, &runtime, &bundleBytes, &capabilityCount)
		if err != nil || runtime != wantRuntime || bundleBytes != wantBytes || capabilityCount != wantCapabilities || (wantVersion == 0 && len(versions) != 0) || (wantVersion != 0 && (len(versions) != 1 || versions[0] != wantVersion)) {
			t.Fatalf("presentation versions=%v runtime=%d capabilities=%d bundle=%d err=%v", versions, runtime, capabilityCount, bundleBytes, err)
		}
	}
	assertPresentationCapabilities(0, 0, 0, 0)
	for _, heartbeat := range []Heartbeat{
		{PresentationSchemaVersions: []int{1}, NativePresentationCapabilities: map[string]int{"layout": 1}, WebRuntimeVersion: 2, WebBundleLimitBytes: 4096},
		{}, // Omission keeps the full report.
		{WebRuntimeVersion: 3, WebBundleLimitBytes: 8192}, // Partial reports still update.
	} {
		if err := service.Heartbeat(ctx, principal, heartbeat, "192.168.1.42:1234"); err != nil {
			t.Fatal(err)
		}
		if heartbeat.WebRuntimeVersion == 3 {
			assertPresentationCapabilities(1, 3, 1, 8192)
		} else {
			assertPresentationCapabilities(1, 2, 1, 4096)
		}
	}
	if err := service.Heartbeat(ctx, principal, Heartbeat{PresentationSchemaVersions: []int{}, NativePresentationCapabilities: map[string]int{}}, "192.168.1.42:1234"); err != nil {
		t.Fatal(err)
	}
	assertPresentationCapabilities(0, 0, 0, 0)
	safeMode := true
	maintenance := time.Now().Add(15 * time.Minute).UTC()
	pinChanged := time.Now().UTC()
	if err := service.Heartbeat(ctx, principal, Heartbeat{ScreenWidth: 1920, ScreenHeight: 1080, PlayerVersion: "0.2.0", ConfiguredReliabilityMode: "managed_kiosk", EffectiveReliabilityMode: "standard", ForegroundState: "foreground", SafeMode: &safeMode, MaintenanceSessionExpiresAt: &maintenance, AdminPINChangedAt: &pinChanged}, "192.168.1.42:1234"); err != nil {
		t.Fatal(err)
	}
	var configured, effective string
	var storedSafe bool
	if err := pool.QueryRow(ctx, `SELECT configured_reliability_mode,effective_reliability_mode,safe_mode FROM screen_player_status WHERE screen_id=$1`, screen.ID).Scan(&configured, &effective, &storedSafe); err != nil || configured != "managed_kiosk" || effective != "standard" || !storedSafe {
		t.Fatalf("reliability status configured=%q effective=%q safe=%v err=%v", configured, effective, storedSafe, err)
	}
	safeMode = false
	maintenance = time.Now().Add(-time.Minute).UTC()
	if err := service.Heartbeat(ctx, principal, Heartbeat{ScreenWidth: 1920, ScreenHeight: 1080, PlayerVersion: "0.2.0", ConfiguredReliabilityMode: "standard", SafeMode: &safeMode, MaintenanceSessionExpiresAt: &maintenance}, "192.168.1.42:1234"); err != nil {
		t.Fatal(err)
	}
	var reliabilityAudits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action IN ('reliability.safe_mode_entered','reliability.safe_mode_exited','reliability.maintenance_started','reliability.maintenance_ended','reliability.admin_pin_changed')`).Scan(&reliabilityAudits); err != nil || reliabilityAudits != 5 {
		t.Fatalf("reliability audits=%d err=%v", reliabilityAudits, err)
	}

	preservedPlaylistID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,created_by) SELECT $1,id,'Preserved assignment',$2 FROM organization_settings WHERE singleton=TRUE`, preservedPlaylistID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by) VALUES($1,$2,$3,$4)`, uuid.New(), screen.ID, preservedPlaylistID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	olderRepair, err := service.CreatePairing(ctx, identity.InstallationID, metadata)
	if err != nil {
		t.Fatal(err)
	}
	repair, err := service.CreatePairing(ctx, identity.InstallationID, metadata)
	if err != nil {
		t.Fatal(err)
	}
	var olderStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM device_pairing_sessions WHERE id=$1`, olderRepair.ID).Scan(&olderStatus); err != nil || olderStatus != "expired" {
		t.Fatalf("older pairing status=%q err=%v", olderStatus, err)
	}
	resolvedRepair, err := service.ResolvePairing(ctx, repair.Code)
	if err != nil || !resolvedRepair.PreviouslyPaired || resolvedRepair.ExistingScreenID == nil || *resolvedRepair.ExistingScreenID != screen.ID || !resolvedRepair.HasActiveCredential {
		t.Fatalf("repair metadata=%#v err=%v", resolvedRepair, err)
	}
	if _, err := service.ApprovePairing(ctx, repair.ID, owner.User.ID, screen.Name, screen.LocationID, screen.RoomName, screen.RoomNumber, screen.Description, false); !errors.Is(err, ErrPairingRecovery) {
		t.Fatalf("expected pairing recovery requirement, got %v", err)
	}
	repairedScreen, err := service.ApprovePairing(ctx, repair.ID, owner.User.ID, screen.Name, screen.LocationID, screen.RoomName, screen.RoomNumber, screen.Description, true)
	if err != nil || repairedScreen.ID != screen.ID {
		t.Fatalf("repair approval=%#v err=%v", repairedScreen, err)
	}
	if duplicate, err := service.ApprovePairing(ctx, repair.ID, owner.User.ID, screen.Name, screen.LocationID, screen.RoomName, screen.RoomNumber, screen.Description, true); err != nil || duplicate.ID != screen.ID {
		t.Fatalf("duplicate approval=%#v err=%v", duplicate, err)
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
	var screenCount, replacementAudits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM screens WHERE player_installation_id=$1`, metadata.PlayerInstallationID).Scan(&screenCount); err != nil || screenCount != 1 {
		t.Fatalf("screen count=%d err=%v", screenCount, err)
	}
	var assignedPlaylistID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT playlist_id FROM screen_playlist_assignments WHERE screen_id=$1`, screen.ID).Scan(&assignedPlaylistID); err != nil || assignedPlaylistID != preservedPlaylistID {
		t.Fatalf("assignment playlist=%s err=%v", assignedPlaylistID, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action='screen.pairing.credential_replaced' AND resource_id=$1`, screen.ID.String()).Scan(&replacementAudits); err != nil || replacementAudits != 1 {
		t.Fatalf("replacement audits=%d err=%v", replacementAudits, err)
	}
	activeCredential := repairEnrollment.DeviceCredential
	if err := service.SetEnabled(ctx, screen.ID, owner.User.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AuthenticateDevice(ctx, activeCredential); !errors.Is(err, ErrDisabledScreen) {
		t.Fatalf("expected disabled screen rejection, got %v", err)
	}
	if err := service.SetEnabled(ctx, screen.ID, owner.User.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := service.Revoke(ctx, screen.ID, owner.User.ID, "integration test"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AuthenticateDevice(ctx, activeCredential); !errors.Is(err, ErrRevokedCredential) {
		t.Fatalf("expected revoked credential rejection, got %v", err)
	}
	listedScreens, err := service.ListScreens(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(listedScreens) != 0 {
		t.Fatalf("revoked screen remained in list: %#v", listedScreens)
	}

	rejected, err := service.CreatePairing(ctx, identity.InstallationID, withNewPlayerID(metadata))
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RejectPairing(ctx, rejected.ID, owner.User.ID, "Unknown device"); err != nil {
		t.Fatal(err)
	}
	rejectedResult, err := service.PollPairing(ctx, rejected.ID, rejected.PollSecret)
	if err != nil || rejectedResult.Status != "rejected" {
		t.Fatalf("rejected result: %#v %v", rejectedResult, err)
	}

	expired, err := service.CreatePairing(ctx, identity.InstallationID, withNewPlayerID(metadata))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE device_pairing_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1`, expired.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResolvePairing(ctx, expired.Code); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected expired resolution, got %v", err)
	}
	expiredResult, err := service.PollPairing(ctx, expired.ID, expired.PollSecret)
	if err != nil || expiredResult.Status != "expired" {
		t.Fatalf("expired poll: %#v %v", expiredResult, err)
	}

	encoded, _ := json.Marshal(metadata)
	_, err = pool.Exec(ctx, `INSERT INTO device_pairing_sessions (id,code_hash,poll_secret_hash,requested_metadata,requested_server_installation_id,player_installation_id,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',now()+interval '10 minutes')`, uuid.New(), secretHash(pairing.Code), secretHash("another-poll-secret"), encoded, identity.InstallationID, uuid.NewString())
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "23505" {
		t.Fatalf("expected duplicate code constraint, got %v", err)
	}
	var auditCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action IN ('screen.pairing.approved','screen.pairing.rejected','screen.disabled','screen.enabled','screen.credential.revoked')`).Scan(&auditCount); err != nil || auditCount != 6 {
		t.Fatalf("audit count=%d err=%v", auditCount, err)
	}
	repairWithoutActive, err := service.CreatePairing(ctx, identity.InstallationID, metadata)
	if err != nil {
		t.Fatal(err)
	}
	withoutActiveScreen, err := service.ApprovePairing(ctx, repairWithoutActive.ID, owner.User.ID, screen.Name, screen.LocationID, screen.RoomName, screen.RoomNumber, screen.Description, false)
	if err != nil || withoutActiveScreen.ID != screen.ID {
		t.Fatalf("repair without active credential=%#v err=%v", withoutActiveScreen, err)
	}
	withoutActiveClaim, err := service.PollPairing(ctx, repairWithoutActive.ID, repairWithoutActive.PollSecret)
	if err != nil {
		t.Fatal(err)
	}
	withoutActiveEnrollment, err := service.Enroll(ctx, repairWithoutActive.ID, withoutActiveClaim.EnrollmentToken)
	if err != nil || withoutActiveEnrollment.ScreenID != screen.ID {
		t.Fatalf("re-enrollment without active credential=%#v err=%v", withoutActiveEnrollment, err)
	}
}

func withNewPlayerID(metadata DeviceMetadata) DeviceMetadata {
	metadata.PlayerInstallationID = uuid.NewString()
	return metadata
}
