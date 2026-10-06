package devices

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/tilecast/tilecast/apps/server/internal/audit"
)

// browserPlayerClient names the Browser Player recovery path in audit rows. A
// recovery is performed by a browser holding a one-time capability, not by a
// signed-in person, so the row carries a client identity and no human actor.
const browserPlayerClient = "tilecast-browser-player"

// recordBrowserAudit writes an operator-attributed row through the shared audit
// path. The calling surface and request come from the context.
func recordBrowserAudit(ctx context.Context, tx pgx.Tx, userID uuid.UUID, action string, screenID uuid.UUID, summary string) error {
	return audit.RecordTx(ctx, tx, audit.Event{
		Action: action, ResourceType: "screen", ResourceID: screenID.String(),
		Actor: &userID, Summary: summary,
	})
}

type BrowserSlot struct {
	ID              uuid.UUID  `json:"id"`
	ScreenID        uuid.UUID  `json:"screenId"`
	RecoveryEnabled bool       `json:"recoveryEnabled"`
	LastRecoveredAt *time.Time `json:"lastRecoveredAt,omitempty"`
}

type BrowserLaunch struct {
	BrowserSlot
	RecoverySecret string `json:"recoverySecret"`
}

func (launch BrowserLaunch) String() string {
	return "BrowserLaunch{slot=" + launch.ID.String() + ", recovery=[redacted]}"
}

func (launch BrowserLaunch) GoString() string { return launch.String() }

// CreateBrowserSlot pre-provisions a logical screen without a fake pairing
// session or an active device credential. The HTTP layer supplies role checks.
func (s *Service) CreateBrowserSlot(ctx context.Context, userID uuid.UUID, input PairingApproval) (BrowserLaunch, error) {
	input.Name, input.RoomName, input.RoomNumber, input.Description = strings.TrimSpace(input.Name), strings.TrimSpace(input.RoomName), strings.TrimSpace(input.RoomNumber), strings.TrimSpace(input.Description)
	if len(input.Name) < 2 || len(input.Name) > 120 || len(input.RoomName) > 120 || len(input.RoomNumber) > 80 || len(input.Description) > 1000 || input.ReplaceExistingCredential || input.ReplaceHardware || input.ReplacementScreenID != nil {
		return BrowserLaunch{}, errors.New("browser screen details are invalid")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return BrowserLaunch{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	screenID, slotID := uuid.New(), uuid.New()
	// The schema requires initial dimensions and installation metadata. These
	// provisional values are replaced by observed metadata during binding.
	_, err = tx.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,description,location_id,room_name,room_number,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
		SELECT $1,id,$2,$3,$4,$5,$6,$7,'browser','','','','',1,1,1,'','' FROM organization_settings WHERE singleton=TRUE`,
		screenID, uuid.NewString(), input.Name, input.Description, input.LocationID, input.RoomName, input.RoomNumber)
	if err != nil {
		return BrowserLaunch{}, fmt.Errorf("create browser screen: %w", err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO browser_player_slots(id,screen_id) VALUES($1,$2)`, slotID, screenID); err != nil {
		return BrowserLaunch{}, err
	}
	secret, err := createBrowserRecovery(ctx, tx, slotID)
	if err != nil {
		return BrowserLaunch{}, err
	}
	if err := recordBrowserAudit(ctx, tx, userID, "screen.browser.created", screenID, "Created a Browser Player Screen"); err != nil {
		return BrowserLaunch{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BrowserLaunch{}, err
	}
	return BrowserLaunch{BrowserSlot: BrowserSlot{ID: slotID, ScreenID: screenID, RecoveryEnabled: true}, RecoverySecret: secret}, nil
}

func createBrowserRecovery(ctx context.Context, tx pgx.Tx, slotID uuid.UUID) (string, error) {
	secret, err := randomSecret(32)
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE browser_player_recovery_credentials SET revoked_at=now() WHERE slot_id=$1 AND revoked_at IS NULL`, slotID); err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `INSERT INTO browser_player_recovery_credentials(id,slot_id,secret_digest) VALUES($1,$2,$3)`, uuid.New(), slotID, secretHash(secret))
	return secret, err
}

func (s *Service) BrowserSlot(ctx context.Context, screenID uuid.UUID) (BrowserSlot, error) {
	var slot BrowserSlot
	err := s.db.QueryRow(ctx, `SELECT p.id,p.screen_id,p.recovery_enabled,
		(SELECT max(last_used_at) FROM browser_player_recovery_credentials WHERE slot_id=p.id)
		FROM browser_player_slots p WHERE p.screen_id=$1`, screenID).Scan(&slot.ID, &slot.ScreenID, &slot.RecoveryEnabled, &slot.LastRecoveredAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return BrowserSlot{}, ErrNotFound
	}
	return slot, err
}

func (s *Service) SetBrowserRecovery(ctx context.Context, screenID, userID uuid.UUID, enabled bool) (BrowserLaunch, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return BrowserLaunch{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var launch BrowserLaunch
	err = tx.QueryRow(ctx, `SELECT p.id,p.screen_id FROM browser_player_slots p JOIN screens s ON s.id=p.screen_id WHERE p.screen_id=$1 AND s.archived_at IS NULL AND s.deleted_at IS NULL FOR UPDATE OF p`, screenID).Scan(&launch.ID, &launch.ScreenID)
	if errors.Is(err, pgx.ErrNoRows) {
		return BrowserLaunch{}, ErrNotFound
	}
	if err != nil {
		return BrowserLaunch{}, err
	}
	launch.RecoveryEnabled = enabled
	if _, err := tx.Exec(ctx, `UPDATE browser_player_slots SET recovery_enabled=$2,updated_at=now() WHERE id=$1`, launch.ID, enabled); err != nil {
		return BrowserLaunch{}, err
	}
	if enabled {
		launch.RecoverySecret, err = createBrowserRecovery(ctx, tx, launch.ID)
	} else {
		_, err = tx.Exec(ctx, `UPDATE browser_player_recovery_credentials SET revoked_at=now() WHERE slot_id=$1 AND revoked_at IS NULL`, launch.ID)
	}
	if err != nil {
		return BrowserLaunch{}, err
	}
	action, summary := "screen.browser.recovery_disabled", "Disabled Browser Player recovery"
	if enabled {
		action, summary = "screen.browser.recovery_regenerated", "Regenerated the Browser Player launch link"
	}
	if err := recordBrowserAudit(ctx, tx, userID, action, screenID, summary); err != nil {
		return BrowserLaunch{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BrowserLaunch{}, err
	}
	return launch, nil
}

func (s *Service) RecoverBrowser(ctx context.Context, slotID uuid.UUID, recoverySecret string, registration BrowserRegistration, metadata DeviceMetadata) (BrowserSession, error) {
	if len(recoverySecret) != 43 || registration.InstallationID == uuid.Nil || metadata.Platform != "browser" || metadata.PlayerInstallationID != registration.InstallationID.String() {
		return BrowserSession{}, ErrInvalidCredential
	}
	if _, err := registration.PublicKey.parse(); err != nil {
		return BrowserSession{}, err
	}
	if err := validateMetadata(metadata); err != nil {
		return BrowserSession{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return BrowserSession{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var session BrowserSession
	// Screen mutations take the Screen lock before the slot lock. Enrollment
	// already follows this order, so recovery cannot deadlock with replacement.
	var lockedScreen uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT s.id FROM screens s JOIN browser_player_slots p ON p.screen_id=s.id WHERE p.id=$1 FOR UPDATE OF s`, slotID).Scan(&lockedScreen); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BrowserSession{}, ErrInvalidCredential
		}
		return BrowserSession{}, err
	}
	var enabled, recoveryEnabled bool
	var expected []byte
	var recoveryID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT p.id,p.screen_id,s.name,p.active_binding_epoch,s.enabled,p.recovery_enabled
		FROM browser_player_slots p JOIN screens s ON s.id=p.screen_id
		WHERE p.id=$1 AND s.platform='browser' AND s.archived_at IS NULL AND s.deleted_at IS NULL FOR UPDATE OF p,s`, slotID).Scan(
		&session.SlotID, &session.ScreenID, &session.ScreenName, &session.Epoch, &enabled, &recoveryEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return BrowserSession{}, ErrInvalidCredential
	}
	if err != nil {
		return BrowserSession{}, err
	}
	if !enabled || !recoveryEnabled {
		return BrowserSession{}, ErrInvalidCredential
	}
	err = tx.QueryRow(ctx, `SELECT id,secret_digest FROM browser_player_recovery_credentials WHERE slot_id=$1 AND revoked_at IS NULL`, slotID).Scan(&recoveryID, &expected)
	if errors.Is(err, pgx.ErrNoRows) {
		return BrowserSession{}, ErrInvalidCredential
	}
	if err != nil {
		return BrowserSession{}, err
	}
	if !secretMatches(expected, recoverySecret) {
		return BrowserSession{}, ErrInvalidCredential
	}
	publicID, secret, _, err := newDeviceCredential()
	if err != nil {
		return BrowserSession{}, err
	}
	credentialID := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash) VALUES($1,$2,$3,$4)`, credentialID, session.ScreenID, publicID, secretHash(secret)); err != nil {
		return BrowserSession{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE screens SET player_installation_id=$2,device_manufacturer=$3,device_model=$4,android_version=$5,player_version=$6,screen_width=$7,screen_height=$8,density=$9,locale=$10,timezone=$11,paired_at=now(),updated_at=now() WHERE id=$1`, session.ScreenID, metadata.PlayerInstallationID, metadata.Manufacturer, metadata.Model, metadata.AndroidVersion, metadata.PlayerVersion, metadata.ScreenWidth, metadata.ScreenHeight, metadata.Density, metadata.Locale, metadata.Timezone); err != nil {
		return BrowserSession{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE browser_player_recovery_credentials SET last_used_at=now() WHERE id=$1`, recoveryID); err != nil {
		return BrowserSession{}, err
	}
	if err := audit.RecordTx(ctx, tx, audit.Event{
		Action: "screen.browser.recovered", ResourceType: "screen", ResourceID: session.ScreenID.String(),
		Surface: audit.SurfaceSystem, ClientID: browserPlayerClient, Summary: "A Browser Player recovered its binding",
		Metadata: map[string]any{"slotId": session.SlotID.String()},
	}); err != nil {
		return BrowserSession{}, err
	}
	session, err = s.bindBrowser(ctx, tx, session, credentialID, registration)
	if err != nil {
		return BrowserSession{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BrowserSession{}, err
	}
	s.presence.Disconnect(session.ScreenID)
	return session, nil
}
