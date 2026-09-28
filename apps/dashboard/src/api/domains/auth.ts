/**
 * Authentication and account-security domain helpers over the typed
 * transport. The WebAuthn ceremonies keep their X-MFA-Challenge header,
 * passed explicitly per call; CSRF stays the authoritative token option.
 * Credential payloads use the contract WebAuthn schemas; the ceremony
 * serializers in ../../auth/webauthn produce exactly these shapes.
 */
import type { components } from "@tilecast/api-schema/generated/openapi";
import { apiDelete, apiGet, apiPatch, apiPost } from "../transport";
import type {
  AuthStatus,
  LoginInput,
  LoginResult,
  OAuthApproval,
  OAuthDecision,
  OAuthGrant,
  Passkey,
  PasskeyCeremony,
  PersonalAccessToken,
  PersonalAccessTokenCreated,
  PersonalAccessTokenInput,
  SecurityStatus,
  SessionResult,
  SetupInput,
  TOTPEnrollment,
} from "../types";

export function getAuthStatus(): Promise<AuthStatus> {
  return apiGet<"/api/v1/auth/status", AuthStatus>("/api/v1/auth/status");
}

export function initialSetup(input: SetupInput): Promise<SessionResult> {
  return apiPost<"/api/v1/auth/setup", SessionResult>("/api/v1/auth/setup", {
    body: input,
  });
}

export function login(input: LoginInput): Promise<LoginResult> {
  return apiPost<"/api/v1/auth/login", LoginResult>("/api/v1/auth/login", {
    body: input,
  });
}

export function verifyMfa(
  challengeToken: string,
  code: string,
): Promise<SessionResult> {
  return apiPost<"/api/v1/auth/mfa/verify", SessionResult>(
    "/api/v1/auth/mfa/verify",
    { body: { challengeToken, code } },
  );
}

export function getMfaPasskeyOptions(
  challengeToken: string,
): Promise<PasskeyCeremony> {
  return apiPost<"/api/v1/auth/mfa/passkey/options", PasskeyCeremony>(
    "/api/v1/auth/mfa/passkey/options",
    { body: { challengeToken } },
  );
}

export function getPasskeyLoginOptions(): Promise<PasskeyCeremony> {
  return apiPost<"/api/v1/auth/passkey/login/options", PasskeyCeremony>(
    "/api/v1/auth/passkey/login/options",
  );
}

export function passkeyLogin(
  challengeToken: string,
  credential: components["schemas"]["WebAuthnAssertion"],
): Promise<SessionResult> {
  return apiPost<"/api/v1/auth/passkey/login", SessionResult>(
    "/api/v1/auth/passkey/login",
    { body: credential, headers: { "X-MFA-Challenge": challengeToken } },
  );
}

export function getSecurityStatus(): Promise<SecurityStatus> {
  return apiGet<"/api/v1/me/security", SecurityStatus>("/api/v1/me/security");
}

export function beginTotpEnrollment(
  csrfToken: string,
): Promise<TOTPEnrollment> {
  return apiPost<"/api/v1/me/security/totp", TOTPEnrollment>(
    "/api/v1/me/security/totp",
    { csrfToken },
  );
}

export function confirmTotpEnrollment(
  code: string,
  csrfToken: string,
): Promise<SecurityStatus> {
  return apiPost<"/api/v1/me/security/totp/confirm", SecurityStatus>(
    "/api/v1/me/security/totp/confirm",
    { body: { code }, csrfToken },
  );
}

export function removeTotp(password: string, csrfToken: string): Promise<void> {
  return apiPost("/api/v1/me/security/totp/remove", {
    body: { password },
    csrfToken,
  });
}

export function regenerateRecoveryCodes(
  password: string,
  csrfToken: string,
): Promise<{ codes: string[] }> {
  return apiPost<"/api/v1/me/security/recovery-codes", { codes: string[] }>(
    "/api/v1/me/security/recovery-codes",
    { body: { password }, csrfToken },
  );
}

export function getPasskeyRegistrationOptions(
  csrfToken: string,
): Promise<PasskeyCeremony> {
  return apiPost<"/api/v1/me/security/passkeys/options", PasskeyCeremony>(
    "/api/v1/me/security/passkeys/options",
    { csrfToken },
  );
}

export function registerPasskey(
  challengeToken: string,
  credential: components["schemas"]["WebAuthnCredential"],
  csrfToken: string,
): Promise<Passkey> {
  return apiPost<"/api/v1/me/security/passkeys", Passkey>(
    "/api/v1/me/security/passkeys",
    {
      body: credential,
      headers: { "X-MFA-Challenge": challengeToken },
      csrfToken,
    },
  );
}

export function renamePasskey(
  id: string,
  name: string,
  csrfToken: string,
): Promise<void> {
  return apiPatch("/api/v1/me/security/passkeys/{id}", {
    params: { path: { id } },
    body: { name },
    csrfToken,
  });
}

export function removePasskey(
  id: string,
  password: string,
  csrfToken: string,
): Promise<void> {
  return apiPost("/api/v1/me/security/passkeys/{id}/remove", {
    params: { path: { id } },
    body: { password },
    csrfToken,
  });
}

export function describeOAuthApproval(
  params: URLSearchParams,
): Promise<OAuthApproval> {
  const get = (key: string): string => params.get(key) ?? "";
  return apiGet<"/api/v1/oauth/authorize", OAuthApproval>(
    "/api/v1/oauth/authorize",
    {
      params: {
        query: {
          client_id: get("client_id"),
          redirect_uri: get("redirect_uri"),
          scope: get("scope"),
          state: params.get("state") ?? undefined,
          code_challenge: get("code_challenge"),
          code_challenge_method:
            params.get("code_challenge_method") === "S256" ? "S256" : undefined,
        },
      },
    },
  );
}

export function approveOAuth(
  decision: OAuthDecision,
  csrfToken: string,
): Promise<{ redirectUri: string }> {
  return apiPost<"/api/v1/oauth/approve", { redirectUri: string }>(
    "/api/v1/oauth/approve",
    { body: decision, csrfToken },
  );
}

export function denyOAuth(
  decision: OAuthDecision,
  csrfToken: string,
): Promise<{ redirectUri: string }> {
  return apiPost<"/api/v1/oauth/deny", { redirectUri: string }>(
    "/api/v1/oauth/deny",
    { body: decision, csrfToken },
  );
}

export function listOAuthGrants(): Promise<{ grants: OAuthGrant[] }> {
  return apiGet<"/api/v1/me/security/grants", { grants: OAuthGrant[] }>(
    "/api/v1/me/security/grants",
  );
}

export function revokeOAuthGrant(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/me/security/grants/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function listPersonalAccessTokens(
  search: string,
): Promise<{ pats: PersonalAccessToken[] }> {
  return apiGet<"/api/v1/me/security/pats", { pats: PersonalAccessToken[] }>(
    "/api/v1/me/security/pats",
    {
      params: { query: search ? { search } : {} },
    },
  );
}

export function createPersonalAccessToken(
  input: PersonalAccessTokenInput,
  csrfToken: string,
): Promise<PersonalAccessTokenCreated> {
  return apiPost<"/api/v1/me/security/pats", PersonalAccessTokenCreated>(
    "/api/v1/me/security/pats",
    { body: input, csrfToken },
  );
}

export function resetUserSecurity(
  id: string,
  csrfToken: string,
): Promise<void> {
  return apiPost("/api/v1/users/{id}/security/reset", {
    params: { path: { id } },
    csrfToken,
  });
}

export function logout(csrfToken: string): Promise<void> {
  return apiPost("/api/v1/auth/logout", { csrfToken });
}
