package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// mfaPolicy reads the organization enrollment requirement. A settings failure
// is reported as "none" so a settings outage cannot lock everyone out; the
// enrollment gate is a policy control, not a security boundary in itself.
func (s *server) mfaPolicy(r *http.Request) auth.MFAPolicy {
	if s.settings == nil {
		return auth.MFAPolicyNone
	}
	document, err := s.settings.Organization(r.Context())
	if err != nil {
		return auth.MFAPolicyNone
	}
	value, _ := document.Values["security.mfa_required_scope"].(string)
	return auth.ParseMFAPolicy(value)
}

func (s *server) organizationDisplayName(r *http.Request) string {
	if s.settings == nil {
		return "Tilecast"
	}
	document, err := s.settings.Organization(r.Context())
	if err != nil {
		return "Tilecast"
	}
	if name, ok := document.Values["organization.name"].(string); ok && strings.TrimSpace(name) != "" {
		return name
	}
	return "Tilecast"
}

// writeMFAError maps the domain errors onto the public contract. Verification
// failures are deliberately uniform: the response never says whether it was
// the factor, the code, or the challenge that was wrong.
func (s *server) writeMFAError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, auth.ErrInvalidChallenge):
		writeError(w, http.StatusUnauthorized, "challenge_expired", "This sign-in attempt has expired. Start again.")
	case errors.Is(err, auth.ErrChallengeExhausted):
		writeError(w, http.StatusTooManyRequests, "challenge_exhausted", "Too many incorrect codes. Start again.")
	case errors.Is(err, auth.ErrInvalidCode):
		writeError(w, http.StatusUnauthorized, "invalid_code", "That code is not correct.")
	case errors.Is(err, auth.ErrPasskeyRejected), errors.Is(err, auth.ErrPasskeyUnknown):
		writeError(w, http.StatusUnauthorized, "passkey_rejected", "That passkey could not be verified.")
	case errors.Is(err, auth.ErrPasskeysUnavailable):
		_, reason := s.auth.PasskeysAvailable()
		writeError(w, http.StatusConflict, "passkeys_unavailable", reason)
	case errors.Is(err, auth.ErrNoUsableFactor):
		writeError(w, http.StatusConflict, "no_usable_factor", "Your account's only second factor cannot be used on this installation. Ask an Owner or Administrator to reset your sign-in security.")
	case errors.Is(err, auth.ErrNoFactor):
		writeError(w, http.StatusNotFound, "factor_not_found", "That factor is not enrolled.")
	case errors.Is(err, auth.ErrFactorExists):
		writeError(w, http.StatusConflict, "factor_exists", "An authenticator app is already enrolled. Remove it first.")
	case errors.Is(err, auth.ErrLastFactor):
		writeError(w, http.StatusConflict, "last_factor", "This organization requires multi-factor authentication for your role. Add another factor before removing this one.")
	case errors.Is(err, auth.ErrInactive):
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "The username or password is incorrect.")
	default:
		s.internalError(w, r, err)
	}
}

// sessionResponse is the shared success shape for every path that produces a
// session, so the dashboard has one branch to handle.
func (s *server) sessionResponse(w http.ResponseWriter, status int, session auth.Session) {
	s.setSessionCookie(w, session)
	writeJSON(w, status, map[string]any{"data": map[string]any{
		"user":                  session.User,
		"csrfToken":             session.CSRFToken,
		"authMethod":            session.AuthMethod,
		"mfaEnrollmentRequired": session.EnrollmentPending,
	}})
}

type mfaVerifyRequest struct {
	ChallengeToken string `json:"challengeToken"`
	Code           string `json:"code"`
}

// verifyMFA completes a password sign-in with an authenticator or recovery code.
func (s *server) verifyMFA(w http.ResponseWriter, r *http.Request) {
	var body mfaVerifyRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	session, err := s.auth.CompleteChallenge(r.Context(), body.ChallengeToken, body.Code, s.mfaPolicy(r))
	if err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	s.sessionResponse(w, http.StatusOK, session)
}

type challengeTokenRequest struct {
	ChallengeToken string `json:"challengeToken"`
}

// beginMFAPasskey turns a pending password sign-in into a passkey assertion.
func (s *server) beginMFAPasskey(w http.ResponseWriter, r *http.Request) {
	var body challengeTokenRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	assertion, token, err := s.auth.BeginPasskeyChallenge(r.Context(), body.ChallengeToken)
	if err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"challengeToken": token, "options": assertion.Response}})
}

// beginPasskeyLogin starts a username-free sign-in.
func (s *server) beginPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	assertion, token, err := s.auth.BeginPasskeyLogin(r.Context())
	if err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"challengeToken": token, "options": assertion.Response}})
}

// finishPasskeyLogin verifies the assertion and issues the session. The
// challenge token travels in a header because the body is the raw WebAuthn
// credential, which the library parses itself.
func (s *server) finishPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("X-MFA-Challenge")
	response, err := protocol.ParseCredentialRequestResponseBody(http.MaxBytesReader(w, r.Body, maxCredentialBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "The passkey response could not be read.")
		return
	}
	session, err := s.auth.FinishPasskeyLogin(r.Context(), token, response, s.mfaPolicy(r))
	if err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	s.sessionResponse(w, http.StatusOK, session)
}

const maxCredentialBytes = 64 << 10

// listFactors reports the signed-in user's own security state.
func (s *server) listFactors(w http.ResponseWriter, r *http.Request) {
	session := r.Context().Value(sessionContextKey).(auth.Session)
	summary, err := s.auth.Factors(r.Context(), session.User.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	available, reason := s.auth.PasskeysAvailable()
	policy := s.mfaPolicy(r)
	// The relying party and user handle let the dashboard tell the browser's
	// passkey provider which credentials this server still accepts, so one
	// removed here stops being offered at sign-in.
	handle, err := s.auth.WebAuthnHandle(r.Context(), session.User.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"relyingPartyId":            s.auth.RelyingPartyID(),
		"userHandle":                handle,
		"totpEnrolled":              summary.TOTPEnrolled,
		"totpConfirmedAt":           summary.TOTPConfirmedAt,
		"passkeys":                  summary.Passkeys,
		"recoveryCodesRemaining":    summary.RecoveryCodesRemaining,
		"enrolled":                  summary.Enrolled,
		"passkeysAvailable":         available,
		"passkeysUnavailableReason": reason,
		"required":                  policy.AppliesTo(session.User.Role),
		"policy":                    string(policy),
		"authMethod":                session.AuthMethod,
	}})
}

// reverifyPassword guards the destructive security operations. Removing a
// factor from a borrowed session should not be possible with the cookie alone.
func (s *server) reverifyPassword(w http.ResponseWriter, r *http.Request, password string) bool {
	session := r.Context().Value(sessionContextKey).(auth.Session)
	if s.auth.VerifyCurrentPassword(r.Context(), session.User.ID, password) {
		return true
	}
	writeError(w, http.StatusForbidden, "password_required", "Enter your current password to change sign-in security.")
	return false
}

func (s *server) beginTOTPEnrollment(w http.ResponseWriter, r *http.Request) {
	session := r.Context().Value(sessionContextKey).(auth.Session)
	uri, secret, err := s.auth.BeginTOTPEnrollment(r.Context(), session.User.ID, s.organizationDisplayName(r), session.User.Username)
	if err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"provisioningUri": uri, "secret": secret}})
}

type codeRequest struct {
	Code string `json:"code"`
}

func (s *server) confirmTOTPEnrollment(w http.ResponseWriter, r *http.Request) {
	var body codeRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	session := r.Context().Value(sessionContextKey).(auth.Session)
	if err := s.auth.ConfirmTOTPEnrollment(r.Context(), session.User.ID, body.Code); err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	s.finishEnrollment(w, r, session.User.ID)
}

type passwordRequest struct {
	Password string `json:"password"`
}

func (s *server) disableTOTP(w http.ResponseWriter, r *http.Request) {
	var body passwordRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !s.reverifyPassword(w, r, body.Password) {
		return
	}
	session := r.Context().Value(sessionContextKey).(auth.Session)
	if err := s.auth.DisableTOTP(r.Context(), session.User.ID, s.mfaPolicy(r), session.User.Role); err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) regenerateRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	var body passwordRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !s.reverifyPassword(w, r, body.Password) {
		return
	}
	session := r.Context().Value(sessionContextKey).(auth.Session)
	codes, err := s.auth.GenerateRecoveryCodes(r.Context(), session.User.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{"codes": codes}})
}

func (s *server) beginPasskeyRegistration(w http.ResponseWriter, r *http.Request) {
	session := r.Context().Value(sessionContextKey).(auth.Session)
	creation, token, err := s.auth.BeginPasskeyRegistration(r.Context(), session.User)
	if err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"challengeToken": token, "options": creation.Response}})
}

func (s *server) finishPasskeyRegistration(w http.ResponseWriter, r *http.Request) {
	session := r.Context().Value(sessionContextKey).(auth.Session)
	token := r.Header.Get("X-MFA-Challenge")
	response, err := protocol.ParseCredentialCreationResponseBody(http.MaxBytesReader(w, r.Body, maxCredentialBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "The passkey response could not be read.")
		return
	}
	summary, err := s.auth.FinishPasskeyRegistration(r.Context(), session.User, token, response)
	if err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	if err := s.auth.MarkEnrollmentSatisfied(r.Context(), session.User.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": summary})
}

type renamePasskeyRequest struct {
	Name string `json:"name"`
}

func (s *server) renamePasskey(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "The passkey identifier is not valid.")
		return
	}
	var body renamePasskeyRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	session := r.Context().Value(sessionContextKey).(auth.Session)
	if err := s.auth.RenamePasskey(r.Context(), session.User.ID, id, body.Name); err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) deletePasskey(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "The passkey identifier is not valid.")
		return
	}
	var body passwordRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !s.reverifyPassword(w, r, body.Password) {
		return
	}
	session := r.Context().Value(sessionContextKey).(auth.Session)
	if err := s.auth.DeletePasskey(r.Context(), session.User.ID, id, s.mfaPolicy(r), session.User.Role); err != nil {
		s.writeMFAError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// finishEnrollment clears the enrollment gate and returns the refreshed state
// so the dashboard can leave the enrollment screen without a reload.
func (s *server) finishEnrollment(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if err := s.auth.MarkEnrollmentSatisfied(r.Context(), userID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.listFactors(w, r)
}

// resetUserFactors is the administrator recovery path for a locked-out user.
func (s *server) resetUserFactors(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "The user identifier is not valid.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	actor := principal.User
	target, err := s.userRole(r, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "user_not_found", "That user does not exist.")
		return
	}
	if !canManageRole(actor.Role, target) {
		writeError(w, http.StatusForbidden, "insufficient_role", "Only an Owner may reset sign-in security for an Owner or Administrator.")
		return
	}
	if err := s.auth.ResetFactors(r.Context(), id, &actor.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) userRole(r *http.Request, id uuid.UUID) (string, error) {
	var role string
	err := s.db.QueryRow(r.Context(), `SELECT role FROM users WHERE id=$1`, id).Scan(&role)
	return role, err
}
