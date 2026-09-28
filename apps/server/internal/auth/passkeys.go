package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	// ErrPasskeysUnavailable reports that this installation cannot run a
	// WebAuthn ceremony, which is the normal state for a plain-HTTP LAN
	// deployment rather than a misconfiguration.
	ErrPasskeysUnavailable = errors.New("passkeys are not available on this installation")
	ErrPasskeyUnknown      = errors.New("this passkey is not registered")
	ErrPasskeyRejected     = errors.New("the passkey could not be verified")
)

// WebAuthnConfig describes the relying party. It is derived from the public
// URL unless an operator overrides it, which is needed behind a proxy whose
// external hostname differs from the one the server sees.
type WebAuthnConfig struct {
	RPDisplayName string
	RPID          string
	Origins       []string
}

// ResolveWebAuthnConfig works out whether passkeys can be offered.
//
// WebAuthn requires a secure context and a registrable domain: an installation
// reached over plain HTTP at an IP address — the default for a signage LAN —
// cannot use passkeys at all, and the honest answer is to say so rather than
// to present a button that always fails. localhost is exempt because browsers
// treat it as a secure context.
func ResolveWebAuthnConfig(displayName, publicURL, overrideRPID, overrideOrigins string) (WebAuthnConfig, string) {
	config := WebAuthnConfig{RPDisplayName: strings.TrimSpace(displayName)}
	if config.RPDisplayName == "" {
		config.RPDisplayName = "Tilecast"
	}

	for _, origin := range strings.Split(overrideOrigins, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			config.Origins = append(config.Origins, strings.TrimSuffix(origin, "/"))
		}
	}
	config.RPID = strings.TrimSpace(overrideRPID)
	if config.RPID != "" && len(config.Origins) > 0 {
		return config, ""
	}

	parsed, err := url.Parse(strings.TrimSpace(publicURL))
	if err != nil || parsed.Hostname() == "" {
		return WebAuthnConfig{}, "TILECAST_PUBLIC_URL is not a valid absolute URL."
	}
	host := parsed.Hostname()
	secure := parsed.Scheme == "https" || host == "localhost" || host == "127.0.0.1" || host == "::1"
	if !secure {
		return WebAuthnConfig{}, "Passkeys require HTTPS. Serve Tilecast over HTTPS and set TILECAST_PUBLIC_URL to the HTTPS address."
	}
	if isIPHost(host) {
		return WebAuthnConfig{}, "Passkeys require a hostname. Browsers reject an IP address as a relying party identifier."
	}
	if config.RPID == "" {
		config.RPID = host
	}
	if len(config.Origins) == 0 {
		origin := parsed.Scheme + "://" + parsed.Host
		config.Origins = []string{origin}
	}
	return config, ""
}

func isIPHost(host string) bool {
	if strings.Contains(host, ":") {
		return true
	}
	for _, part := range strings.Split(host, ".") {
		if part == "" {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

// ConfigurePasskeys enables the passkey ceremonies. When unavailable is set,
// the reason is reported to the dashboard and every ceremony is refused.
func (s *Service) ConfigurePasskeys(config WebAuthnConfig, unavailableReason string) error {
	if unavailableReason != "" {
		s.passkeyUnavailable = unavailableReason
		return nil
	}
	instance, err := webauthn.New(&webauthn.Config{
		RPID:          config.RPID,
		RPDisplayName: config.RPDisplayName,
		RPOrigins:     config.Origins,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			// Discoverable credentials are what make a username-free sign-in
			// possible, and user verification is what makes the passkey a
			// second factor rather than only a first one.
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		},
	})
	if err != nil {
		// The WebAuthn library validates the relying party more strictly with
		// each release. A rejected configuration must disable passkeys, not
		// stop signage from starting.
		s.passkeyUnavailable = "Passkeys are unavailable: " + err.Error()
		return nil
	}
	s.webauthn = instance
	s.passkeyUnavailable = ""
	return nil
}

// PasskeysAvailable reports whether ceremonies can run, and why not otherwise.
func (s *Service) PasskeysAvailable() (bool, string) {
	return s.webauthn != nil, s.passkeyUnavailable
}

// RelyingPartyID is the domain credentials are scoped to. The dashboard needs
// it to report accepted credentials back to the user's passkey provider.
func (s *Service) RelyingPartyID() string {
	if s.webauthn == nil {
		return ""
	}
	return s.webauthn.Config.RPID
}

// WebAuthnHandle returns the user's opaque WebAuthn identifier, or an empty
// string when they have never enrolled a passkey.
func (s *Service) WebAuthnHandle(ctx context.Context, userID uuid.UUID) (string, error) {
	var handle []byte
	if err := s.db.QueryRow(ctx, `SELECT webauthn_handle FROM users WHERE id=$1`, userID).Scan(&handle); err != nil {
		return "", fmt.Errorf("read user handle: %w", err)
	}
	if len(handle) == 0 {
		return "", nil
	}
	return base64.RawURLEncoding.EncodeToString(handle), nil
}

// webauthnUser adapts a Tilecast account to the library's user interface.
type webauthnUser struct {
	user        User
	handle      []byte
	credentials []webauthn.Credential
}

func (u webauthnUser) WebAuthnID() []byte                         { return u.handle }
func (u webauthnUser) WebAuthnName() string                       { return u.user.Username }
func (u webauthnUser) WebAuthnDisplayName() string                { return u.user.Name }
func (u webauthnUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

func (s *Service) webauthnUser(ctx context.Context, user User, create bool) (webauthnUser, error) {
	var handle []byte
	err := s.db.QueryRow(ctx, `SELECT webauthn_handle FROM users WHERE id=$1`, user.ID).Scan(&handle)
	if err != nil {
		return webauthnUser{}, fmt.Errorf("read user handle: %w", err)
	}
	if len(handle) == 0 {
		if !create {
			return webauthnUser{}, ErrNoFactor
		}
		handle = make([]byte, 32)
		if _, err := rand.Read(handle); err != nil {
			return webauthnUser{}, fmt.Errorf("generate user handle: %w", err)
		}
		if _, err := s.db.Exec(ctx, `UPDATE users SET webauthn_handle=$2 WHERE id=$1 AND webauthn_handle IS NULL`, user.ID, handle); err != nil {
			return webauthnUser{}, fmt.Errorf("store user handle: %w", err)
		}
		if err := s.db.QueryRow(ctx, `SELECT webauthn_handle FROM users WHERE id=$1`, user.ID).Scan(&handle); err != nil {
			return webauthnUser{}, fmt.Errorf("read user handle: %w", err)
		}
	}
	credentials, err := s.passkeyCredentials(ctx, user.ID)
	if err != nil {
		return webauthnUser{}, err
	}
	return webauthnUser{user: user, handle: handle, credentials: credentials}, nil
}

func (s *Service) passkeyCredentials(ctx context.Context, userID uuid.UUID) ([]webauthn.Credential, error) {
	rows, err := s.db.Query(ctx, `SELECT credential FROM user_passkeys WHERE user_id=$1`, userID)
	if err != nil {
		return nil, fmt.Errorf("read passkey credentials: %w", err)
	}
	defer rows.Close()
	credentials := []webauthn.Credential{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("scan passkey credential: %w", err)
		}
		var credential webauthn.Credential
		if err := json.Unmarshal(raw, &credential); err != nil {
			return nil, fmt.Errorf("decode passkey credential: %w", err)
		}
		credentials = append(credentials, credential)
	}
	return credentials, rows.Err()
}

// BeginPasskeyRegistration starts enrollment for a signed-in user and returns
// the creation options plus the challenge token that carries the ceremony.
func (s *Service) BeginPasskeyRegistration(ctx context.Context, user User) (*protocol.CredentialCreation, string, error) {
	if s.webauthn == nil {
		return nil, "", ErrPasskeysUnavailable
	}
	subject, err := s.webauthnUser(ctx, user, true)
	if err != nil {
		return nil, "", err
	}
	exclusions := make([]protocol.CredentialDescriptor, 0, len(subject.credentials))
	for _, credential := range subject.credentials {
		exclusions = append(exclusions, credential.Descriptor())
	}
	creation, session, err := s.webauthn.BeginRegistration(subject, webauthn.WithExclusions(exclusions))
	if err != nil {
		return nil, "", fmt.Errorf("begin passkey registration: %w", err)
	}
	encoded, err := json.Marshal(session)
	if err != nil {
		return nil, "", fmt.Errorf("encode passkey ceremony: %w", err)
	}
	token, err := s.createChallenge(ctx, &user.ID, "passkey_registration", encoded)
	if err != nil {
		return nil, "", err
	}
	return creation, token, nil
}

// FinishPasskeyRegistration stores a verified credential. The name is derived
// from the authenticator rather than asked for: the user already answered a
// system prompt to get here, and "1Password" or "Windows Hello" identifies the
// credential better than whatever they would have typed. It stays renameable.
func (s *Service) FinishPasskeyRegistration(ctx context.Context, user User, token string, response *protocol.ParsedCredentialCreationData) (PasskeySummary, error) {
	if s.webauthn == nil {
		return PasskeySummary{}, ErrPasskeysUnavailable
	}
	record, err := s.loadChallenge(ctx, token, "passkey_registration")
	if err != nil {
		return PasskeySummary{}, err
	}
	if record.userID == nil || *record.userID != user.ID {
		return PasskeySummary{}, ErrInvalidChallenge
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(record.session, &session); err != nil {
		return PasskeySummary{}, fmt.Errorf("decode passkey ceremony: %w", err)
	}
	subject, err := s.webauthnUser(ctx, user, true)
	if err != nil {
		return PasskeySummary{}, err
	}
	credential, err := s.webauthn.CreateCredential(subject, session, response)
	if err != nil {
		s.failChallenge(ctx, record.id)
		return PasskeySummary{}, ErrPasskeyRejected
	}
	if err := s.deleteChallenge(ctx, record.id); err != nil {
		return PasskeySummary{}, err
	}

	encoded, err := json.Marshal(credential)
	if err != nil {
		return PasskeySummary{}, fmt.Errorf("encode passkey credential: %w", err)
	}
	existing, err := s.Factors(ctx, user.ID)
	if err != nil {
		return PasskeySummary{}, err
	}
	summary := PasskeySummary{
		ID:        uuid.New(),
		Name:      uniquePasskeyName(describePasskey(credential), existing.Passkeys),
		CreatedAt: time.Now().UTC(),
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO user_passkeys (id,user_id,credential_id,credential,name,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		summary.ID, user.ID, credential.ID, encoded, summary.Name, summary.CreatedAt); err != nil {
		return PasskeySummary{}, fmt.Errorf("store passkey: %w", err)
	}
	if err := s.recordAudit(ctx, user.ID, "auth.mfa.passkey_enrolled"); err != nil {
		return PasskeySummary{}, err
	}
	return summary, nil
}

// passkeyName bounds a user-supplied rename. The limit counts runes, not
// bytes: slicing a byte index can cut a multi-byte character in half, and
// PostgreSQL rejects the resulting invalid UTF-8 outright.
func passkeyName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Passkey"
	}
	runes := []rune(name)
	if len(runes) > 60 {
		return strings.TrimSpace(string(runes[:60]))
	}
	return name
}

// RenamePasskey updates the label shown on the security page.
func (s *Service) RenamePasskey(ctx context.Context, userID, passkeyID uuid.UUID, name string) error {
	tag, err := s.db.Exec(ctx, `UPDATE user_passkeys SET name=$3 WHERE id=$2 AND user_id=$1`, userID, passkeyID, passkeyName(name))
	if err != nil {
		return fmt.Errorf("rename passkey: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoFactor
	}
	return nil
}

// DeletePasskey removes one credential, refusing to remove the last factor of
// an account the organization policy requires to have one.
func (s *Service) DeletePasskey(ctx context.Context, userID, passkeyID uuid.UUID, policy MFAPolicy, role string) error {
	summary, err := s.Factors(ctx, userID)
	if err != nil {
		return err
	}
	if policy.AppliesTo(role) && !summary.TOTPEnrolled && len(summary.Passkeys) <= 1 {
		return ErrLastFactor
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM user_passkeys WHERE id=$2 AND user_id=$1`, userID, passkeyID)
	if err != nil {
		return fmt.Errorf("remove passkey: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoFactor
	}
	return s.recordAudit(ctx, userID, "auth.mfa.passkey_removed")
}

// BeginPasskeyLogin starts a discoverable ceremony. No username is supplied
// and none is revealed: the authenticator decides which account responds.
func (s *Service) BeginPasskeyLogin(ctx context.Context) (*protocol.CredentialAssertion, string, error) {
	if s.webauthn == nil {
		return nil, "", ErrPasskeysUnavailable
	}
	assertion, session, err := s.webauthn.BeginDiscoverableLogin()
	if err != nil {
		return nil, "", fmt.Errorf("begin passkey sign-in: %w", err)
	}
	encoded, err := json.Marshal(session)
	if err != nil {
		return nil, "", fmt.Errorf("encode passkey ceremony: %w", err)
	}
	token, err := s.createChallenge(ctx, nil, "passkey_login", encoded)
	if err != nil {
		return nil, "", err
	}
	return assertion, token, nil
}

// FinishPasskeyLogin verifies a discoverable assertion and issues a session.
// A verified passkey satisfies the multi-factor requirement on its own: it is
// possession of the authenticator plus the user verification it performed.
func (s *Service) FinishPasskeyLogin(ctx context.Context, token string, response *protocol.ParsedCredentialAssertionData, policy MFAPolicy) (Session, error) {
	if s.webauthn == nil {
		return Session{}, ErrPasskeysUnavailable
	}
	record, err := s.loadChallenge(ctx, token, "passkey_login")
	if err != nil {
		return Session{}, err
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(record.session, &session); err != nil {
		return Session{}, fmt.Errorf("decode passkey ceremony: %w", err)
	}

	var matched User
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		user, err := s.userByWebAuthnHandle(ctx, userHandle)
		if err != nil {
			return nil, err
		}
		matched = user
		return s.webauthnUser(ctx, user, false)
	}
	credential, err := s.webauthn.ValidateDiscoverableLogin(handler, session, response)
	if err != nil {
		s.failChallenge(ctx, record.id)
		if errors.Is(err, ErrInactive) {
			return Session{}, ErrInactive
		}
		return Session{}, ErrPasskeyRejected
	}
	if err := s.deleteChallenge(ctx, record.id); err != nil {
		return Session{}, err
	}
	if err := s.updatePasskeyUse(ctx, credential); err != nil {
		return Session{}, err
	}
	return s.completeLogin(ctx, matched, "passkey", policy)
}

// BeginPasskeyChallenge continues a password sign-in whose second factor is a
// passkey rather than a code.
func (s *Service) BeginPasskeyChallenge(ctx context.Context, token string) (*protocol.CredentialAssertion, string, error) {
	if s.webauthn == nil {
		return nil, "", ErrPasskeysUnavailable
	}
	record, err := s.loadChallenge(ctx, token, "login")
	if err != nil {
		return nil, "", err
	}
	if record.userID == nil {
		return nil, "", ErrInvalidChallenge
	}
	user, err := s.loadUser(ctx, *record.userID)
	if err != nil {
		return nil, "", err
	}
	subject, err := s.webauthnUser(ctx, user, false)
	if err != nil {
		return nil, "", err
	}
	if len(subject.credentials) == 0 {
		return nil, "", ErrNoFactor
	}
	assertion, session, err := s.webauthn.BeginLogin(subject)
	if err != nil {
		return nil, "", fmt.Errorf("begin passkey verification: %w", err)
	}
	encoded, err := json.Marshal(session)
	if err != nil {
		return nil, "", fmt.Errorf("encode passkey ceremony: %w", err)
	}
	// The pending sign-in is replaced by a ceremony-bearing challenge so the
	// original token cannot also be spent on a code.
	if err := s.deleteChallenge(ctx, record.id); err != nil {
		return nil, "", err
	}
	next, err := s.createChallenge(ctx, &user.ID, "passkey_login", encoded)
	if err != nil {
		return nil, "", err
	}
	return assertion, next, nil
}

func (s *Service) userByWebAuthnHandle(ctx context.Context, handle []byte) (User, error) {
	var user User
	err := s.db.QueryRow(ctx, `SELECT id,name,username,role,active,created_at,last_login_at FROM users WHERE webauthn_handle=$1`, handle).
		Scan(&user.ID, &user.Name, &user.Username, &user.Role, &user.Active, &user.CreatedAt, &user.LastLoginAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrPasskeyUnknown
	}
	if err != nil {
		return User{}, fmt.Errorf("find passkey user: %w", err)
	}
	if !user.Active {
		return User{}, ErrInactive
	}
	return user, nil
}

// updatePasskeyUse persists the credential record after a successful
// assertion. The sign count and backup flags move, and discarding them would
// forfeit clone detection.
func (s *Service) updatePasskeyUse(ctx context.Context, credential *webauthn.Credential) error {
	encoded, err := json.Marshal(credential)
	if err != nil {
		return fmt.Errorf("encode passkey credential: %w", err)
	}
	if _, err := s.db.Exec(ctx, `UPDATE user_passkeys SET credential=$2, last_used_at=now() WHERE credential_id=$1`, credential.ID, encoded); err != nil {
		return fmt.Errorf("record passkey use: %w", err)
	}
	return nil
}
