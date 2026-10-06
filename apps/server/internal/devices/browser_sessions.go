package devices

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const BrowserSessionLifetime = 30 * 24 * time.Hour

func (s *Service) bindBrowser(ctx context.Context, tx pgx.Tx, session BrowserSession, credentialID uuid.UUID, registration BrowserRegistration) (BrowserSession, error) {
	if err := tx.QueryRow(ctx, `UPDATE browser_player_slots SET active_binding_epoch=active_binding_epoch+1,updated_at=now() WHERE id=$1 RETURNING active_binding_epoch`, session.SlotID).Scan(&session.Epoch); err != nil {
		return BrowserSession{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE browser_player_bindings SET revoked_at=now() WHERE slot_id=$1 AND revoked_at IS NULL`, session.SlotID); err != nil {
		return BrowserSession{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM browser_player_sessions WHERE binding_id IN (SELECT id FROM browser_player_bindings WHERE slot_id=$1)`, session.SlotID); err != nil {
		return BrowserSession{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM browser_player_challenges WHERE binding_id IN (SELECT id FROM browser_player_bindings WHERE slot_id=$1)`, session.SlotID); err != nil {
		return BrowserSession{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE device_credentials SET revoked_at=now(),revocation_reason='Browser binding replaced' WHERE screen_id=$1 AND id<>$2 AND revoked_at IS NULL`, session.ScreenID, credentialID); err != nil {
		return BrowserSession{}, err
	}
	session.BindingID = uuid.New()
	publicJSON, err := json.Marshal(registration.PublicKey)
	if err != nil {
		return BrowserSession{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO browser_player_bindings(id,slot_id,epoch,credential_id,installation_id,public_key) VALUES($1,$2,$3,$4,$5,$6)`, session.BindingID, session.SlotID, session.Epoch, credentialID, registration.InstallationID, publicJSON); err != nil {
		return BrowserSession{}, err
	}
	return s.issueBrowserSession(ctx, tx, session)
}

type BrowserRegistration struct {
	InstallationID uuid.UUID        `json:"installationId"`
	PublicKey      BrowserPublicKey `json:"publicKey"`
}

// SessionSecret is internal HTTP cookie material. It must never be encoded in
// a response body, logs, audit metadata, or client-readable persistence.
type BrowserSession struct {
	SlotID        uuid.UUID `json:"slotId"`
	BindingID     uuid.UUID `json:"bindingId"`
	ScreenID      uuid.UUID `json:"screenId"`
	ScreenName    string    `json:"screenName"`
	Epoch         int64     `json:"epoch"`
	ExpiresAt     time.Time `json:"expiresAt"`
	SessionSecret string    `json:"-"`
}

func (session BrowserSession) String() string {
	return "BrowserSession{slot=" + session.SlotID.String() + ", secret=[redacted]}"
}

func (session BrowserSession) GoString() string { return session.String() }

func (s *Service) issueBrowserSession(ctx context.Context, tx pgx.Tx, session BrowserSession) (BrowserSession, error) {
	secret, err := randomSecret(32)
	if err != nil {
		return BrowserSession{}, err
	}
	session.SessionSecret = secret
	session.ExpiresAt = s.now().UTC().Add(BrowserSessionLifetime)
	if _, err := tx.Exec(ctx, `DELETE FROM browser_player_sessions WHERE binding_id=$1`, session.BindingID); err != nil {
		return BrowserSession{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO browser_player_sessions(secret_digest,binding_id,expires_at) VALUES($1,$2,$3)`, secretHash(secret), session.BindingID, session.ExpiresAt); err != nil {
		return BrowserSession{}, err
	}
	return session, nil
}

// AuthenticateBrowser resolves to the same domain principal as native auth.
// Browser cookies are accepted only by the separate Browser HTTP middleware.
func (s *Service) AuthenticateBrowser(ctx context.Context, secret string) (DevicePrincipal, BrowserSession, error) {
	if len(secret) != 43 {
		return DevicePrincipal{}, BrowserSession{}, ErrInvalidCredential
	}
	var principal DevicePrincipal
	var session BrowserSession
	err := s.db.QueryRow(ctx, `SELECT b.credential_id,s.id,s.name,s.enabled,p.id,b.id,b.epoch,bs.expires_at
		FROM browser_player_sessions bs
		JOIN browser_player_bindings b ON b.id=bs.binding_id
		JOIN browser_player_slots p ON p.id=b.slot_id
		JOIN device_credentials c ON c.id=b.credential_id
		JOIN screens s ON s.id=p.screen_id
		WHERE bs.secret_digest=$1 AND bs.expires_at>$2 AND b.revoked_at IS NULL
		AND c.revoked_at IS NULL AND b.epoch=p.active_binding_epoch
		AND s.archived_at IS NULL AND s.deleted_at IS NULL`, secretHash(secret), s.now()).Scan(
		&principal.CredentialID, &principal.ScreenID, &principal.ScreenName, &principal.Enabled,
		&session.SlotID, &session.BindingID, &session.Epoch, &session.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return DevicePrincipal{}, BrowserSession{}, ErrInvalidCredential
	}
	if err != nil {
		return DevicePrincipal{}, BrowserSession{}, fmt.Errorf("authenticate browser session: %w", err)
	}
	if !principal.Enabled {
		return DevicePrincipal{}, BrowserSession{}, ErrDisabledScreen
	}
	session.ScreenID, session.ScreenName = principal.ScreenID, principal.ScreenName
	return principal, session, nil
}

type BrowserChallenge struct {
	Nonce     string    `json:"nonce"`
	Message   string    `json:"message"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func browserChallengeMessage(slotID, bindingID uuid.UUID, nonce string) string {
	return "tilecast-browser-player-v1:" + slotID.String() + ":" + bindingID.String() + ":" + nonce
}

func (s *Service) BrowserChallenge(ctx context.Context, slotID, bindingID uuid.UUID) (BrowserChallenge, error) {
	nonce, err := randomSecret(32)
	if err != nil {
		return BrowserChallenge{}, err
	}
	expires := s.now().UTC().Add(2 * time.Minute)
	result, err := s.db.Exec(ctx, `INSERT INTO browser_player_challenges(binding_id,nonce_digest,expires_at)
		SELECT b.id,$3,$4 FROM browser_player_bindings b
		JOIN browser_player_slots p ON p.id=b.slot_id JOIN screens s ON s.id=p.screen_id
		JOIN device_credentials c ON c.id=b.credential_id
		WHERE p.id=$1 AND b.id=$2 AND b.epoch=p.active_binding_epoch AND b.revoked_at IS NULL
		AND c.revoked_at IS NULL AND s.enabled AND s.archived_at IS NULL AND s.deleted_at IS NULL
		ON CONFLICT(binding_id) DO UPDATE SET nonce_digest=EXCLUDED.nonce_digest,expires_at=EXCLUDED.expires_at`,
		slotID, bindingID, secretHash(nonce), expires)
	if err != nil {
		return BrowserChallenge{}, err
	}
	if result.RowsAffected() != 1 {
		return BrowserChallenge{}, ErrInvalidCredential
	}
	return BrowserChallenge{Nonce: nonce, Message: browserChallengeMessage(slotID, bindingID, nonce), ExpiresAt: expires}, nil
}

func (s *Service) RenewBrowserSession(ctx context.Context, slotID, bindingID uuid.UUID, nonce, signature string) (BrowserSession, error) {
	if len(nonce) != 43 || len(signature) != 86 {
		return BrowserSession{}, ErrInvalidCredential
	}
	// Consume before signature verification. An invalid signature also consumes
	// the challenge; a retry needs a new rate-limited challenge.
	var digest []byte
	var expires time.Time
	err := s.db.QueryRow(ctx, `DELETE FROM browser_player_challenges WHERE binding_id=$1 RETURNING nonce_digest,expires_at`, bindingID).Scan(&digest, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return BrowserSession{}, ErrInvalidCredential
	}
	if err != nil {
		return BrowserSession{}, err
	}
	if !expires.After(s.now()) || !secretMatches(digest, nonce) {
		return BrowserSession{}, ErrInvalidCredential
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return BrowserSession{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var session BrowserSession
	var publicJSON []byte
	// The slot lock serializes renewal with recovery. No old-epoch session
	// can be issued after a new recovery transaction commits.
	err = tx.QueryRow(ctx, `SELECT p.id,b.id,s.id,s.name,b.epoch,b.public_key
		FROM browser_player_slots p JOIN browser_player_bindings b ON b.slot_id=p.id
		JOIN screens s ON s.id=p.screen_id JOIN device_credentials c ON c.id=b.credential_id
		WHERE p.id=$1 AND b.id=$2 AND b.epoch=p.active_binding_epoch AND b.revoked_at IS NULL
		AND c.revoked_at IS NULL AND s.enabled AND s.archived_at IS NULL AND s.deleted_at IS NULL
		FOR UPDATE OF p`, slotID, bindingID).Scan(&session.SlotID, &session.BindingID, &session.ScreenID, &session.ScreenName, &session.Epoch, &publicJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return BrowserSession{}, ErrInvalidCredential
	}
	if err != nil {
		return BrowserSession{}, err
	}
	var key BrowserPublicKey
	if json.Unmarshal(publicJSON, &key) != nil || !verifyBrowserSignature(key, browserChallengeMessage(slotID, bindingID, nonce), signature) {
		return BrowserSession{}, ErrInvalidCredential
	}
	session, err = s.issueBrowserSession(ctx, tx, session)
	if err != nil {
		return BrowserSession{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BrowserSession{}, err
	}
	return session, nil
}
