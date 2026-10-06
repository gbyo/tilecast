package devices

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestBrowserRecoveryEpochAndKeyRenewal(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	lock, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if _, err := pool.Exec(ctx, `TRUNCATE organization_settings,users,screens,sessions,audit_logs CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Browser Library", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, NewPresenceHub(), "https://signage.example.org")
	launch, err := service.CreateBrowserSlot(ctx, owner.User.ID, PairingApproval{Name: "Browser Lobby", Description: "Logical screen"})
	if err != nil {
		t.Fatal(err)
	}
	awaiting, err := service.GetScreen(ctx, launch.ScreenID)
	if err != nil || awaiting.Status != StatusAwaitingPlayer || awaiting.HasActiveCredential {
		t.Fatalf("pre-provisioned Screen is not awaiting a Player: %v", err)
	}
	screens, err := service.ListScreens(ctx)
	if err != nil || len(screens) != 1 || screens[0].ID != launch.ScreenID {
		t.Fatalf("awaiting Screen is missing from the fleet: %v", err)
	}
	private, public := browserTestKey(t)
	installation := uuid.New()
	registration := BrowserRegistration{InstallationID: installation, PublicKey: public}
	metadata := DeviceMetadata{PlayerInstallationID: installation.String(), Platform: "browser", Manufacturer: "Browser", Model: "Chromium", AndroidVersion: "Not applicable", PlayerVersion: "test", ScreenWidth: 1920, ScreenHeight: 1080, Density: 1, Locale: "en-US", Timezone: "UTC"}
	first, err := service.RecoverBrowser(ctx, launch.ID, launch.RecoverySecret, registration, metadata)
	if err != nil {
		t.Fatal(err)
	}
	principal, _, err := service.AuthenticateBrowser(ctx, first.SessionSecret)
	if err != nil || principal.ScreenID != launch.ScreenID || first.Epoch != 1 {
		t.Fatalf("initial recovery failed: %v", err)
	}
	if _, err := service.AuthenticateDevice(ctx, first.SessionSecret); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("browser session accepted as native credential")
	}
	challenge, err := service.BrowserChallenge(ctx, first.SlotID, first.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	signature := browserTestSignature(t, private, challenge.Message)
	renewed, err := service.RenewBrowserSession(ctx, first.SlotID, first.BindingID, challenge.Nonce, signature)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.AuthenticateBrowser(ctx, renewed.SessionSecret); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RenewBrowserSession(ctx, first.SlotID, first.BindingID, challenge.Nonce, signature); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("challenge replay accepted")
	}
	challenge, err = service.BrowserChallenge(ctx, first.SlotID, first.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	wrongPrivate, _ := browserTestKey(t)
	if _, err := service.RenewBrowserSession(ctx, first.SlotID, first.BindingID, challenge.Nonce, browserTestSignature(t, wrongPrivate, challenge.Message)); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("wrong device signature accepted")
	}
	if _, err := service.RenewBrowserSession(ctx, first.SlotID, first.BindingID, challenge.Nonce, browserTestSignature(t, private, challenge.Message)); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("failed challenge was not consumed")
	}
	// Total site-data loss registers another key on the same logical Screen.
	_, replacementPublic := browserTestKey(t)
	replacementID := uuid.New()
	metadata.PlayerInstallationID = replacementID.String()
	second, err := service.RecoverBrowser(ctx, launch.ID, launch.RecoverySecret, BrowserRegistration{InstallationID: replacementID, PublicKey: replacementPublic}, metadata)
	if err != nil || second.ScreenID != first.ScreenID || second.Epoch != 2 {
		t.Fatalf("replacement failed: %v", err)
	}
	if _, _, err := service.AuthenticateBrowser(ctx, renewed.SessionSecret); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("previous epoch still authenticates")
	}
	if _, err := service.BrowserChallenge(ctx, first.SlotID, first.BindingID); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("old device key can start reauthentication")
	}
	otherSlot, err := service.CreateBrowserSlot(ctx, owner.User.ID, PairingApproval{Name: "Other Browser"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.RecoverBrowser(ctx, otherSlot.ID, launch.RecoverySecret, BrowserRegistration{InstallationID: replacementID, PublicKey: replacementPublic}, metadata); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("recovery bound a different Screen")
	}
	regenerated, err := service.SetBrowserRecovery(ctx, first.ScreenID, owner.User.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.RecoverBrowser(ctx, launch.ID, launch.RecoverySecret, BrowserRegistration{InstallationID: replacementID, PublicKey: replacementPublic}, metadata); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("old recovery link remained usable")
	}
	if len(regenerated.RecoverySecret) != 43 {
		t.Fatal("recovery secret lacks 256-bit encoding")
	}
	if _, err := service.SetBrowserRecovery(ctx, first.ScreenID, owner.User.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RecoverBrowser(ctx, launch.ID, regenerated.RecoverySecret, BrowserRegistration{InstallationID: replacementID, PublicKey: replacementPublic}, metadata); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("disabled recovery link accepted")
	}
	if _, _, err := service.AuthenticateBrowser(ctx, second.SessionSecret); err != nil {
		t.Fatal("disabling recovery invalidated an enrolled session")
	}
	if err := service.Revoke(ctx, second.ScreenID, owner.User.ID, "Retired browser"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.AuthenticateBrowser(ctx, second.SessionSecret); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("revoked Screen still authenticates")
	}
	// Ordinary pairing shares the existing approval and one-time enrollment.
	identity, err := service.Identity(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pairedID := uuid.New()
	metadata.PlayerInstallationID = pairedID.String()
	pairing, err := service.CreatePairing(ctx, identity.InstallationID, metadata)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ApprovePairingWithOptions(ctx, pairing.ID, owner.User.ID, PairingApproval{Name: "Paired browser"}); err != nil {
		t.Fatal(err)
	}
	polled, err := service.PollPairing(ctx, pairing.ID, pairing.PollSecret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Enroll(ctx, pairing.ID, polled.EnrollmentToken); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("browser pairing exposed a permanent native bearer credential")
	}
	paired, err := service.EnrollBrowser(ctx, pairing.ID, polled.EnrollmentToken, BrowserRegistration{InstallationID: pairedID, PublicKey: public})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.AuthenticateBrowser(ctx, paired.SessionSecret); err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnrollBrowser(ctx, pairing.ID, polled.EnrollmentToken, BrowserRegistration{InstallationID: pairedID, PublicKey: public}); !errors.Is(err, ErrAlreadyClaimed) {
		t.Fatal("browser enrollment token was reusable")
	}
}
