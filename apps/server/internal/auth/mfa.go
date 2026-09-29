package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrInvalidChallenge   = errors.New("the sign-in attempt has expired")
	ErrInvalidCode        = errors.New("the code is incorrect")
	ErrNoFactor           = errors.New("no matching factor is enrolled")
	ErrFactorExists       = errors.New("a factor of this type is already enrolled")
	ErrLastFactor         = errors.New("multi-factor authentication is required for this account")
	ErrChallengeExhausted = errors.New("too many incorrect codes")
	// ErrNoUsableFactor means the account is enrolled, but none of its factors
	// can be presented on this installation.
	ErrNoUsableFactor = errors.New("no enrolled factor can be used here")
)

const (
	challengeTTL      = 10 * time.Minute
	challengeMaxTries = 5
	recoveryCodeCount = 10
	recoveryGroupLen  = 4
	recoveryGroups    = 3
)

// MFAPolicy is the organization-wide enrollment requirement.
type MFAPolicy string

const (
	MFAPolicyNone           MFAPolicy = "none"
	MFAPolicyAdministrators MFAPolicy = "administrators"
	MFAPolicyAll            MFAPolicy = "all"
)

// ParseMFAPolicy maps a stored setting value onto the policy, defaulting to
// none so a malformed value can never lock an installation out.
func ParseMFAPolicy(value string) MFAPolicy {
	switch MFAPolicy(strings.TrimSpace(value)) {
	case MFAPolicyAdministrators:
		return MFAPolicyAdministrators
	case MFAPolicyAll:
		return MFAPolicyAll
	default:
		return MFAPolicyNone
	}
}

// AppliesTo reports whether a role must have a factor enrolled.
func (p MFAPolicy) AppliesTo(role string) bool {
	switch p {
	case MFAPolicyAll:
		return true
	case MFAPolicyAdministrators:
		return role == "owner" || role == "administrator"
	default:
		return false
	}
}

// PasskeySummary describes an enrolled passkey without exposing key material.
// CredentialID is the public credential handle, not a secret; the browser
// needs it to tell the user's passkey provider which credentials this server
// still accepts, so a passkey removed here disappears from their list too.
type PasskeySummary struct {
	ID           uuid.UUID  `json:"id"`
	Name         string     `json:"name"`
	CredentialID string     `json:"credentialId"`
	CreatedAt    time.Time  `json:"createdAt"`
	LastUsedAt   *time.Time `json:"lastUsedAt,omitempty"`
}

// FactorSummary is the security state shown on a user's own security page.
type FactorSummary struct {
	TOTPEnrolled           bool             `json:"totpEnrolled"`
	TOTPConfirmedAt        *time.Time       `json:"totpConfirmedAt,omitempty"`
	Passkeys               []PasskeySummary `json:"passkeys"`
	RecoveryCodesRemaining int              `json:"recoveryCodesRemaining"`
	Enrolled               bool             `json:"enrolled"`
}

// Challenge is a password-verified sign-in that still needs a second factor.
type Challenge struct {
	Token   string   `json:"token"`
	Methods []string `json:"methods"`
	Expires time.Time
}

func (s *Service) Factors(ctx context.Context, userID uuid.UUID) (FactorSummary, error) {
	summary := FactorSummary{Passkeys: []PasskeySummary{}}
	var confirmedAt *time.Time
	err := s.db.QueryRow(ctx, `SELECT confirmed_at FROM user_totp_factors WHERE user_id=$1 AND confirmed_at IS NOT NULL`, userID).Scan(&confirmedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return FactorSummary{}, fmt.Errorf("read authenticator factor: %w", err)
	}
	if confirmedAt != nil {
		summary.TOTPEnrolled = true
		summary.TOTPConfirmedAt = confirmedAt
	}

	rows, err := s.db.Query(ctx, `SELECT id,name,credential_id,created_at,last_used_at FROM user_passkeys WHERE user_id=$1 ORDER BY created_at`, userID)
	if err != nil {
		return FactorSummary{}, fmt.Errorf("read passkeys: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var passkey PasskeySummary
		var credentialID []byte
		if err := rows.Scan(&passkey.ID, &passkey.Name, &credentialID, &passkey.CreatedAt, &passkey.LastUsedAt); err != nil {
			return FactorSummary{}, fmt.Errorf("scan passkey: %w", err)
		}
		passkey.CredentialID = base64.RawURLEncoding.EncodeToString(credentialID)
		summary.Passkeys = append(summary.Passkeys, passkey)
	}
	if err := rows.Err(); err != nil {
		return FactorSummary{}, fmt.Errorf("read passkeys: %w", err)
	}

	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL`, userID).Scan(&summary.RecoveryCodesRemaining); err != nil {
		return FactorSummary{}, fmt.Errorf("count recovery codes: %w", err)
	}
	summary.Enrolled = summary.TOTPEnrolled || len(summary.Passkeys) > 0
	return summary, nil
}

// EnrolledUserIDs returns the users with at least one confirmed factor, so the
// user list can show enrollment state without a query per row.
func (s *Service) EnrolledUserIDs(ctx context.Context) (map[uuid.UUID]bool, error) {
	rows, err := s.db.Query(ctx, `
		SELECT user_id FROM user_totp_factors WHERE confirmed_at IS NOT NULL
		UNION
		SELECT user_id FROM user_passkeys`)
	if err != nil {
		return nil, fmt.Errorf("read enrolled users: %w", err)
	}
	defer rows.Close()
	enrolled := map[uuid.UUID]bool{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan enrolled user: %w", err)
		}
		enrolled[id] = true
	}
	return enrolled, rows.Err()
}

// BeginTOTPEnrollment creates or replaces an unconfirmed authenticator secret.
// An existing confirmed factor is left untouched until the new one is proven,
// so an abandoned enrollment cannot remove working access.
func (s *Service) BeginTOTPEnrollment(ctx context.Context, userID uuid.UUID, issuer, account string) (string, string, error) {
	var confirmed *time.Time
	err := s.db.QueryRow(ctx, `SELECT confirmed_at FROM user_totp_factors WHERE user_id=$1`, userID).Scan(&confirmed)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", "", fmt.Errorf("read authenticator factor: %w", err)
	}
	if confirmed != nil {
		return "", "", ErrFactorExists
	}
	secret, err := newTOTPSecret()
	if err != nil {
		return "", "", err
	}
	if _, err := s.db.Exec(ctx, `
		INSERT INTO user_totp_factors (user_id, secret, created_at) VALUES ($1,$2,now())
		ON CONFLICT (user_id) DO UPDATE SET secret=EXCLUDED.secret, created_at=now(), last_used_step=NULL`, userID, secret); err != nil {
		return "", "", fmt.Errorf("store authenticator secret: %w", err)
	}
	return TOTPProvisioningURI(secret, issuer, account), TOTPSecretKey(secret), nil
}

// ConfirmTOTPEnrollment activates a pending secret once the user proves they
// hold it.
func (s *Service) ConfirmTOTPEnrollment(ctx context.Context, userID uuid.UUID, code string) error {
	var secret []byte
	var confirmed *time.Time
	err := s.db.QueryRow(ctx, `SELECT secret, confirmed_at FROM user_totp_factors WHERE user_id=$1`, userID).Scan(&secret, &confirmed)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNoFactor
	}
	if err != nil {
		return fmt.Errorf("read authenticator factor: %w", err)
	}
	if confirmed != nil {
		return ErrFactorExists
	}
	step, ok := verifyTOTP(secret, code, time.Now(), nil)
	if !ok {
		return ErrInvalidCode
	}
	if _, err := s.db.Exec(ctx, `UPDATE user_totp_factors SET confirmed_at=now(), last_used_step=$2 WHERE user_id=$1`, userID, step); err != nil {
		return fmt.Errorf("confirm authenticator factor: %w", err)
	}
	return s.recordAudit(ctx, userID, "auth.mfa.totp_enrolled")
}

// DisableTOTP removes the authenticator factor. The caller is responsible for
// having reverified the account password first.
func (s *Service) DisableTOTP(ctx context.Context, userID uuid.UUID, policy MFAPolicy, role string) error {
	summary, err := s.Factors(ctx, userID)
	if err != nil {
		return err
	}
	if !summary.TOTPEnrolled {
		return ErrNoFactor
	}
	if policy.AppliesTo(role) && len(summary.Passkeys) == 0 {
		return ErrLastFactor
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM user_totp_factors WHERE user_id=$1`, userID); err != nil {
		return fmt.Errorf("remove authenticator factor: %w", err)
	}
	return s.recordAudit(ctx, userID, "auth.mfa.totp_removed")
}

// GenerateRecoveryCodes replaces every unused code with a fresh set. The plain
// codes are returned exactly once and only their hashes are kept.
func (s *Service) GenerateRecoveryCodes(ctx context.Context, userID uuid.UUID) ([]string, error) {
	codes := make([]string, 0, recoveryCodeCount)
	hashes := make([]string, 0, recoveryCodeCount)
	for range recoveryCodeCount {
		code, err := newRecoveryCode()
		if err != nil {
			return nil, err
		}
		hash, err := HashPassword(normalizeRecoveryCode(code))
		if err != nil {
			return nil, fmt.Errorf("hash recovery code: %w", err)
		}
		codes = append(codes, code)
		hashes = append(hashes, hash)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin recovery codes: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `DELETE FROM user_recovery_codes WHERE user_id=$1`, userID); err != nil {
		return nil, fmt.Errorf("clear recovery codes: %w", err)
	}
	for _, hash := range hashes {
		if _, err := tx.Exec(ctx, `INSERT INTO user_recovery_codes (id,user_id,code_hash) VALUES ($1,$2,$3)`, uuid.New(), userID, hash); err != nil {
			return nil, fmt.Errorf("store recovery code: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs (id,user_id,action,resource_type,resource_id) VALUES ($1,$2,'auth.mfa.recovery_codes_generated','user',$3)`, uuid.New(), userID, userID.String()); err != nil {
		return nil, fmt.Errorf("record recovery code audit log: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit recovery codes: %w", err)
	}
	return codes, nil
}

// ResetFactors clears every factor for a user and forces re-enrollment. It is
// the administrator and break-glass recovery path.
func (s *Service) ResetFactors(ctx context.Context, userID uuid.UUID, actorID *uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin factor reset: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	for _, statement := range []string{
		`DELETE FROM user_totp_factors WHERE user_id=$1`,
		`DELETE FROM user_passkeys WHERE user_id=$1`,
		`DELETE FROM user_recovery_codes WHERE user_id=$1`,
		`DELETE FROM mfa_challenges WHERE user_id=$1`,
	} {
		if _, err := tx.Exec(ctx, statement, userID); err != nil {
			return fmt.Errorf("clear factors: %w", err)
		}
	}
	// Existing sessions kept their access through a factor that no longer
	// exists, so they are revoked rather than left running.
	if err := RevokeUserSessions(ctx, tx, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs (id,user_id,action,resource_type,resource_id) VALUES ($1,$2,'auth.mfa.reset','user',$3)`, uuid.New(), actorID, userID.String()); err != nil {
		return fmt.Errorf("record factor reset audit log: %w", err)
	}
	return tx.Commit(ctx)
}

// MarkEnrollmentSatisfied clears the pending flag on the user's sessions once a
// policy-required factor exists, so enrollment does not require a new sign-in.
func (s *Service) MarkEnrollmentSatisfied(ctx context.Context, userID uuid.UUID) error {
	if _, err := s.db.Exec(ctx, `UPDATE sessions SET enrollment_pending=FALSE WHERE user_id=$1 AND enrollment_pending`, userID); err != nil {
		return fmt.Errorf("clear enrollment gate: %w", err)
	}
	return nil
}

func (s *Service) createChallenge(ctx context.Context, userID *uuid.UUID, purpose string, session []byte) (string, error) {
	token, err := randomToken(32)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256([]byte(token))
	if _, err := s.db.Exec(ctx, `INSERT INTO mfa_challenges (id,user_id,token_hash,purpose,webauthn_session,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		uuid.New(), userID, hash[:], purpose, session, time.Now().UTC().Add(challengeTTL)); err != nil {
		return "", fmt.Errorf("create challenge: %w", err)
	}
	return token, nil
}

type challengeRecord struct {
	id       uuid.UUID
	userID   *uuid.UUID
	purpose  string
	session  []byte
	attempts int
}

func (s *Service) loadChallenge(ctx context.Context, token, purpose string) (challengeRecord, error) {
	if token == "" {
		return challengeRecord{}, ErrInvalidChallenge
	}
	hash := sha256.Sum256([]byte(token))
	var record challengeRecord
	err := s.db.QueryRow(ctx, `SELECT id,user_id,purpose,webauthn_session,attempts FROM mfa_challenges WHERE token_hash=$1 AND expires_at>now()`, hash[:]).
		Scan(&record.id, &record.userID, &record.purpose, &record.session, &record.attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return challengeRecord{}, ErrInvalidChallenge
	}
	if err != nil {
		return challengeRecord{}, fmt.Errorf("read challenge: %w", err)
	}
	if record.purpose != purpose {
		return challengeRecord{}, ErrInvalidChallenge
	}
	if record.attempts >= challengeMaxTries {
		_ = s.deleteChallenge(ctx, record.id)
		return challengeRecord{}, ErrChallengeExhausted
	}
	return record, nil
}

func (s *Service) deleteChallenge(ctx context.Context, id uuid.UUID) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM mfa_challenges WHERE id=$1`, id); err != nil {
		return fmt.Errorf("consume challenge: %w", err)
	}
	return nil
}

func (s *Service) failChallenge(ctx context.Context, id uuid.UUID) {
	_, _ = s.db.Exec(ctx, `UPDATE mfa_challenges SET attempts=attempts+1 WHERE id=$1`, id)
}

// PurgeExpiredChallenges removes abandoned ceremonies. Challenges are short
// lived, but nothing else deletes the rows of a user who never finishes.
func (s *Service) PurgeExpiredChallenges(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM mfa_challenges WHERE expires_at<now()`); err != nil {
		return fmt.Errorf("purge challenges: %w", err)
	}
	return nil
}

// CompleteChallenge verifies a TOTP or recovery code against a pending sign-in
// and returns the session it unlocks.
func (s *Service) CompleteChallenge(ctx context.Context, token, code string, policy MFAPolicy) (Session, error) {
	record, err := s.loadChallenge(ctx, token, "login")
	if err != nil {
		return Session{}, err
	}
	if record.userID == nil {
		return Session{}, ErrInvalidChallenge
	}
	user, err := s.loadUser(ctx, *record.userID)
	if err != nil {
		return Session{}, err
	}

	method, ok, err := s.consumeCode(ctx, user.ID, code)
	if err != nil {
		return Session{}, err
	}
	if !ok {
		s.failChallenge(ctx, record.id)
		return Session{}, ErrInvalidCode
	}
	if err := s.deleteChallenge(ctx, record.id); err != nil {
		return Session{}, err
	}
	return s.completeLogin(ctx, user, method, policy)
}

// consumeCode accepts either a TOTP code or an unused recovery code. Recovery
// codes are tried only when the code does not look like a TOTP code, so a
// mistyped app code can never burn a recovery code.
func (s *Service) consumeCode(ctx context.Context, userID uuid.UUID, code string) (string, bool, error) {
	trimmed := strings.TrimSpace(code)
	if len(normalizeTOTPCode(trimmed)) == totpDigits && !strings.ContainsAny(trimmed, "-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") {
		var secret []byte
		var lastStep *int64
		err := s.db.QueryRow(ctx, `SELECT secret,last_used_step FROM user_totp_factors WHERE user_id=$1 AND confirmed_at IS NOT NULL`, userID).Scan(&secret, &lastStep)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		if err != nil {
			return "", false, fmt.Errorf("read authenticator factor: %w", err)
		}
		step, ok := verifyTOTP(secret, trimmed, time.Now(), lastStep)
		if !ok {
			return "", false, nil
		}
		if _, err := s.db.Exec(ctx, `UPDATE user_totp_factors SET last_used_step=$2 WHERE user_id=$1`, userID, step); err != nil {
			return "", false, fmt.Errorf("record authenticator step: %w", err)
		}
		return "totp", true, nil
	}

	normalized := normalizeRecoveryCode(trimmed)
	if normalized == "" {
		return "", false, nil
	}
	rows, err := s.db.Query(ctx, `SELECT id,code_hash FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL`, userID)
	if err != nil {
		return "", false, fmt.Errorf("read recovery codes: %w", err)
	}
	defer rows.Close()
	type candidate struct {
		id   uuid.UUID
		hash string
	}
	candidates := []candidate{}
	for rows.Next() {
		var found candidate
		if err := rows.Scan(&found.id, &found.hash); err != nil {
			return "", false, fmt.Errorf("scan recovery code: %w", err)
		}
		candidates = append(candidates, found)
	}
	if err := rows.Err(); err != nil {
		return "", false, fmt.Errorf("read recovery codes: %w", err)
	}
	for _, found := range candidates {
		if !VerifyPassword(found.hash, normalized) {
			continue
		}
		// The update is conditional so two concurrent submissions of the same
		// code cannot both succeed.
		tag, err := s.db.Exec(ctx, `UPDATE user_recovery_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL`, found.id)
		if err != nil {
			return "", false, fmt.Errorf("consume recovery code: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return "", false, nil
		}
		return "recovery_code", true, nil
	}
	return "", false, nil
}

func (s *Service) loadUser(ctx context.Context, id uuid.UUID) (User, error) {
	var user User
	err := s.db.QueryRow(ctx, `SELECT id,name,username,role,active,created_at,last_login_at FROM users WHERE id=$1`, id).
		Scan(&user.ID, &user.Name, &user.Username, &user.Role, &user.Active, &user.CreatedAt, &user.LastLoginAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, fmt.Errorf("find user: %w", err)
	}
	if !user.Active {
		return User{}, ErrInactive
	}
	return user, nil
}

// An alphabet without visually ambiguous characters, because recovery codes
// get written down and read back by hand. 32 symbols means each character
// carries five bits, so a twelve-character code carries sixty.
const recoveryAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"

func newRecoveryCode() (string, error) {
	groups := make([]string, 0, recoveryGroups)
	for range recoveryGroups {
		group := make([]byte, 0, recoveryGroupLen)
		for range recoveryGroupLen {
			index, err := rand.Int(rand.Reader, big.NewInt(int64(len(recoveryAlphabet))))
			if err != nil {
				return "", fmt.Errorf("generate recovery code: %w", err)
			}
			group = append(group, recoveryAlphabet[index.Int64()])
		}
		groups = append(groups, string(group))
	}
	return strings.Join(groups, "-"), nil
}

func normalizeRecoveryCode(code string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		case r >= '0' && r <= '9':
			return r
		default:
			return -1
		}
	}, code)
}

func (s *Service) recordAudit(ctx context.Context, userID uuid.UUID, action string) error {
	if _, err := s.db.Exec(ctx, `INSERT INTO audit_logs (id,user_id,action,resource_type,resource_id) VALUES ($1,$2,$3,'user',$4)`, uuid.New(), userID, action, userID.String()); err != nil {
		return fmt.Errorf("record audit log: %w", err)
	}
	return nil
}
