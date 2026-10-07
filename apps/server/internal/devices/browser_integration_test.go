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
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// browserEnvironment is a clean installation with an Owner. Audit rows need a
// calling surface, which a Studio request supplies.
func browserEnvironment(t *testing.T) (context.Context, *pgxpool.Pool, auth.Session, *Service) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := audit.WithSurface(context.Background(), audit.SurfaceStudio)
	pool, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	lock, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lock.Release)
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) }) //nolint:errcheck
	if _, err := pool.Exec(ctx, `TRUNCATE organization_settings,users,screens,sessions,audit_logs CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Browser Library", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	return ctx, pool, owner, NewService(pool, NewPresenceHub(), "https://signage.example.org")
}

func TestBrowserRecoveryEpochAndKeyRenewal(t *testing.T) {
	ctx, _, owner, service := browserEnvironment(t)
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

func browserTestMetadata(installation uuid.UUID) DeviceMetadata {
	return DeviceMetadata{PlayerInstallationID: installation.String(), Platform: "browser", Manufacturer: "Browser", Model: "Chromium", AndroidVersion: "Not applicable", PlayerVersion: "test", ScreenWidth: 1920, ScreenHeight: 1080, Density: 1, Locale: "en-US", Timezone: "UTC"}
}

func TestBrowserRenewalRequiresTheExactChallengeForTheSlotAndBinding(t *testing.T) {
	ctx, _, owner, service := browserEnvironment(t)
	launch, err := service.CreateBrowserSlot(ctx, owner.User.ID, PairingApproval{Name: "Renewal"})
	if err != nil {
		t.Fatal(err)
	}
	private, public := browserTestKey(t)
	installation := uuid.New()
	first, err := service.RecoverBrowser(ctx, launch.ID, launch.RecoverySecret, BrowserRegistration{InstallationID: installation, PublicKey: public}, browserTestMetadata(installation))
	if err != nil {
		t.Fatal(err)
	}
	renew := func(name string, sign func(BrowserChallenge) string, slot, binding uuid.UUID, wantOK bool) {
		consumed := binding == first.BindingID
		t.Helper()
		challenge, err := service.BrowserChallenge(ctx, first.SlotID, first.BindingID)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		_, err = service.RenewBrowserSession(ctx, slot, binding, challenge.Nonce, sign(challenge))
		if wantOK != (err == nil) {
			t.Fatalf("%s: renewal result %v, want ok=%v", name, err, wantOK)
		}
		// A failed attempt for the real binding consumes its challenge. A request
		// naming a binding that does not exist cannot touch anyone's challenge.
		if wantOK || !consumed {
			return
		}
		if _, err := service.RenewBrowserSession(ctx, first.SlotID, first.BindingID, challenge.Nonce, browserTestSignature(t, private, challenge.Message)); !errors.Is(err, ErrInvalidCredential) {
			t.Fatalf("%s: challenge survived a failed attempt", name)
		}
	}
	renew("nonce-only signature", func(c BrowserChallenge) string { return browserTestSignature(t, private, c.Nonce) }, first.SlotID, first.BindingID, false)
	renew("message for another slot", func(c BrowserChallenge) string {
		return browserTestSignature(t, private, browserChallengeMessage(uuid.New(), first.BindingID, c.Nonce))
	}, first.SlotID, first.BindingID, false)
	renew("message for another binding", func(c BrowserChallenge) string {
		return browserTestSignature(t, private, browserChallengeMessage(first.SlotID, uuid.New(), c.Nonce))
	}, first.SlotID, first.BindingID, false)
	renew("request for another slot", func(c BrowserChallenge) string { return browserTestSignature(t, private, c.Message) }, uuid.New(), first.BindingID, false)
	renew("request for another binding", func(c BrowserChallenge) string { return browserTestSignature(t, private, c.Message) }, first.SlotID, uuid.New(), false)
	renew("the exact server message", func(c BrowserChallenge) string { return browserTestSignature(t, private, c.Message) }, first.SlotID, first.BindingID, true)

	// A replaced binding cannot renew, even with an unexpired challenge it was issued.
	challenge, err := service.BrowserChallenge(ctx, first.SlotID, first.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	_, replacementKey := browserTestKey(t)
	replacement := uuid.New()
	if _, err := service.RecoverBrowser(ctx, launch.ID, launch.RecoverySecret, BrowserRegistration{InstallationID: replacement, PublicKey: replacementKey}, browserTestMetadata(replacement)); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RenewBrowserSession(ctx, first.SlotID, first.BindingID, challenge.Nonce, browserTestSignature(t, private, challenge.Message)); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("a replaced binding renewed its session")
	}
}

func TestBrowserRevokePairingIsPermanent(t *testing.T) {
	ctx, _, owner, service := browserEnvironment(t)
	launch, err := service.CreateBrowserSlot(ctx, owner.User.ID, PairingApproval{Name: "Retired"})
	if err != nil {
		t.Fatal(err)
	}
	private, public := browserTestKey(t)
	installation := uuid.New()
	registration := BrowserRegistration{InstallationID: installation, PublicKey: public}
	session, err := service.RecoverBrowser(ctx, launch.ID, launch.RecoverySecret, registration, browserTestMetadata(installation))
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Revoke(ctx, launch.ScreenID, owner.User.ID, "Retired"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.AuthenticateBrowser(ctx, session.SessionSecret); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("an existing session cookie survived revocation")
	}
	if _, err := service.BrowserChallenge(ctx, session.SlotID, session.BindingID); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("the previous device key can still start reauthentication")
	}
	if _, err := service.RenewBrowserSession(ctx, session.SlotID, session.BindingID, strings.Repeat("A", 43), browserTestSignature(t, private, browserChallengeMessage(session.SlotID, session.BindingID, strings.Repeat("A", 43)))); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("the previous device key renewed a session")
	}
	// The one-time launch link is revoked with the pairing, for any browser.
	for _, key := range []BrowserRegistration{registration, {InstallationID: uuid.New(), PublicKey: public}} {
		metadata := browserTestMetadata(key.InstallationID)
		if _, err := service.RecoverBrowser(ctx, launch.ID, launch.RecoverySecret, key, metadata); !errors.Is(err, ErrInvalidCredential) {
			t.Fatal("the old managed recovery capability recreated a binding")
		}
	}
	if slot, err := service.BrowserSlot(ctx, launch.ScreenID); err == nil && slot.RecoveryEnabled {
		t.Fatal("browser recovery remained enabled")
	}
}

func TestBrowserAuditRowsUseTheSharedAttributionPath(t *testing.T) {
	ctx, pool, owner, service := browserEnvironment(t)
	launch, err := service.CreateBrowserSlot(ctx, owner.User.ID, PairingApproval{Name: "Audited"})
	if err != nil {
		t.Fatal(err)
	}
	_, public := browserTestKey(t)
	installation := uuid.New()
	if _, err := service.RecoverBrowser(ctx, launch.ID, launch.RecoverySecret, BrowserRegistration{InstallationID: installation, PublicKey: public}, browserTestMetadata(installation)); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT action,calling_surface,COALESCE(client_id,''),user_id IS NOT NULL FROM audit_logs WHERE action LIKE 'screen.browser.%' ORDER BY created_at,action`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string][3]any{}
	for rows.Next() {
		var action, surface, client string
		var human bool
		if err := rows.Scan(&action, &surface, &client, &human); err != nil {
			t.Fatal(err)
		}
		got[action] = [3]any{surface, client, human}
	}
	if got["screen.browser.created"] != [3]any{"studio", "", true} {
		t.Fatalf("creation is attributed to %v", got["screen.browser.created"])
	}
	// Recovery is a browser holding a capability, not a person.
	if got["screen.browser.recovered"] != [3]any{"system", "tilecast-browser-player", false} {
		t.Fatalf("recovery is attributed to %v", got["screen.browser.recovered"])
	}
}

func TestBrowserHeartbeatStoresItsBoundedSectionAndNoOneElsesDoes(t *testing.T) {
	ctx, pool, owner, service := browserEnvironment(t)
	launch, err := service.CreateBrowserSlot(ctx, owner.User.ID, PairingApproval{Name: "Status"})
	if err != nil {
		t.Fatal(err)
	}
	_, public := browserTestKey(t)
	installation := uuid.New()
	session, err := service.RecoverBrowser(ctx, launch.ID, launch.RecoverySecret, BrowserRegistration{InstallationID: installation, PublicKey: public}, browserTestMetadata(installation))
	if err != nil {
		t.Fatal(err)
	}
	principal, _, err := service.AuthenticateBrowser(ctx, session.SessionSecret)
	if err != nil {
		t.Fatal(err)
	}
	stored := func() (string, string, bool) {
		var section *string
		var foreground *string
		var keepAwake *bool
		if err := pool.QueryRow(ctx, `SELECT browser_status::text,foreground_state,keep_screen_on FROM screen_player_status WHERE screen_id=$1`, principal.ScreenID).Scan(&section, &foreground, &keepAwake); err != nil {
			t.Fatal(err)
		}
		value, state := "", ""
		if section != nil {
			value = *section
		}
		if foreground != nil {
			state = *foreground
		}
		return value, state, keepAwake != nil && *keepAwake
	}
	heartbeat := Heartbeat{
		ScreenWidth: 1280, ScreenHeight: 720, PlayerVersion: "0.1.0", PlayerFamily: "browser", PlaybackState: "idle",
		SafeMode: ptr(false), ForegroundState: "background", KeepScreenOn: ptr(false), ActiveHoursState: "active",
		Browser: &BrowserStatus{BrowserName: "chrome", BrowserMajorVersion: ptr(154), DisplayMode: "browser_tab", StoragePersistence: "best_effort", WakeLock: "released", OfflineContent: "ready"},
	}
	if err := service.Heartbeat(ctx, principal, heartbeat, "127.0.0.1:1"); err != nil {
		t.Fatal(err)
	}
	section, foreground, _ := stored()
	if foreground != "background" || !strings.Contains(section, `"storagePersistence": "best_effort"`) || !strings.Contains(section, `"browserMajorVersion": 154`) {
		t.Fatalf("browser section or generic fact not stored: %q %q", section, foreground)
	}
	// A later heartbeat replaces the section instead of merging into it.
	heartbeat.Browser = &BrowserStatus{BrowserName: "edge", StoragePersistence: "persistent"}
	heartbeat.ForegroundState = "foreground"
	if err := service.Heartbeat(ctx, principal, heartbeat, "127.0.0.1:1"); err != nil {
		t.Fatal(err)
	}
	section, foreground, _ = stored()
	if strings.Contains(section, "chrome") || strings.Contains(section, "best_effort") || foreground != "foreground" {
		t.Fatalf("section was merged rather than replaced: %q", section)
	}
	// A Screen that stops reporting itself as a browser stops showing the section.
	heartbeat.PlayerFamily = "electron-linux"
	if err := service.Heartbeat(ctx, principal, heartbeat, "127.0.0.1:1"); err != nil {
		t.Fatal(err)
	}
	if section, _, _ = stored(); section != "" {
		t.Fatalf("a non-browser heartbeat left a Browser section: %q", section)
	}
}
