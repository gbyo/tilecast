import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Passkey, SecurityStatus } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  isPasskeyCancellation,
  passkeysSupported,
  serializeRegistration,
  signalAcceptedCredentials,
  toCreationOptions,
} from "../auth/webauthn";
import { FormField } from "../components/FormField";
import { SecurityQr } from "../components/SecurityQr";
import { Button, Panel, SectionHeader } from "../components/legacy-ui";
import "./SecurityPage.css";

export const securityKey = ["me", "security"] as const;

export function SecurityPage() {
  const security = useQuery({ queryKey: securityKey, queryFn: api.security });
  if (security.isLoading)
    return <div className="table-loading">Loading sign-in security…</div>;
  if (!security.data)
    return (
      <div className="notice notice--error" role="alert">
        Sign-in security could not be loaded.
      </div>
    );
  return <SecurityPanels status={security.data} />;
}

export function SecurityPanels({ status }: { status: SecurityStatus }) {
  return (
    <section className="security-page">
      <AuthenticatorPanel status={status} />
      <PasskeyPanel status={status} />
      <RecoveryCodePanel status={status} />
    </section>
  );
}

function useSecurityRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: securityKey });
    // The enrollment gate lives on the session, so the auth status has to
    // catch up before the dashboard will let the user through.
    void client.invalidateQueries({ queryKey: ["auth", "status"] });
  };
}

function AuthenticatorPanel({ status }: { status: SecurityStatus }) {
  const { status: auth } = useAuth();
  const csrfToken = auth?.csrfToken ?? "";
  const refresh = useSecurityRefresh();
  const [enrolling, setEnrolling] = useState(false);
  const [code, setCode] = useState("");
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState("");

  const begin = useMutation({
    mutationFn: () => api.beginTotpEnrollment(csrfToken),
    onSuccess: () => setEnrolling(true),
  });
  const confirm = useMutation({
    mutationFn: () => api.confirmTotpEnrollment(code, csrfToken),
    onSuccess: () => {
      setEnrolling(false);
      setCode("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeTotp(password, csrfToken),
    onSuccess: () => {
      setRemoving(false);
      setPassword("");
      refresh();
    },
  });

  return (
    <Panel>
      <SectionHeader
        title="Authenticator app"
        level={3}
        description="A six-digit code from an app such as Aegis, Google Authenticator, or 1Password."
        actions={
          status.totpEnrolled ? (
            <Button
              variant="danger"
              onClick={() => setRemoving((open) => !open)}
            >
              Remove
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={begin.isPending}
              onClick={() => begin.mutate()}
            >
              Set up
            </Button>
          )
        }
      />
      <p className="security-status">
        {status.totpEnrolled ? (
          <>
            <strong>Enrolled</strong>
            {status.totpConfirmedAt &&
              ` — added ${new Date(status.totpConfirmedAt).toLocaleDateString()}`}
          </>
        ) : (
          "Not enrolled"
        )}
      </p>
      {errorNotice(begin.error ?? confirm.error ?? remove.error)}

      {enrolling && begin.data && (
        <div className="security-enroll">
          <SecurityQr uri={begin.data.provisioningUri} />
          <div className="security-enroll__steps">
            <p>
              Scan the code with your authenticator app, then enter the
              six-digit code it shows.
            </p>
            <p className="security-enroll__secret">
              Cannot scan? Enter this key by hand:
              <code>{begin.data.secret}</code>
            </p>
            <FormField
              id="totp-code"
              label="Six-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <div className="security-actions">
              <Button
                variant="primary"
                loading={confirm.isPending}
                onClick={() => confirm.mutate()}
              >
                Confirm
              </Button>
              <Button variant="quiet" onClick={() => setEnrolling(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {removing && (
        <PasswordConfirm
          id="totp-remove"
          label="Confirm your password to remove the authenticator"
          value={password}
          onChange={setPassword}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setRemoving(false)}
        />
      )}
    </Panel>
  );
}

function PasskeyPanel({ status }: { status: SecurityStatus }) {
  const { status: auth } = useAuth();
  const csrfToken = auth?.csrfToken ?? "";
  const refresh = useSecurityRefresh();
  const [renaming, setRenaming] = useState<Passkey>();
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<Passkey>();
  const [password, setPassword] = useState("");
  const supported = passkeysSupported();

  // Once the list settles, tell the user's passkey provider which credentials
  // are still valid here, so anything removed in Studio stops being offered.
  useEffect(() => {
    void signalAcceptedCredentials(
      status.relyingPartyId,
      status.userHandle,
      status.passkeys.map((passkey) => passkey.credentialId),
    );
  }, [status.relyingPartyId, status.userHandle, status.passkeys]);

  // No name is asked for. The user already answered a system prompt to get
  // here; the authenticator tells us what it is, and it can be renamed later.
  const register = useMutation({
    mutationFn: async () => {
      const ceremony = await api.passkeyRegistrationOptions(csrfToken);
      const credential = (await navigator.credentials.create({
        publicKey: toCreationOptions(ceremony.options),
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error("No passkey was created.");
      return api.registerPasskey(
        ceremony.challengeToken,
        serializeRegistration(credential),
        csrfToken,
      );
    },
    onSuccess: refresh,
  });
  const rename = useMutation({
    mutationFn: () => {
      if (!renaming) throw new Error("Select a passkey to rename.");
      return api.renamePasskey(renaming.id, name, csrfToken);
    },
    onSuccess: () => {
      setRenaming(undefined);
      setName("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => {
      if (!removing) throw new Error("Select a passkey to remove.");
      return api.removePasskey(removing.id, password, csrfToken);
    },
    onSuccess: () => {
      setRemoving(undefined);
      setPassword("");
      refresh();
    },
  });

  return (
    <Panel>
      <SectionHeader
        title="Passkeys"
        level={3}
        description="Sign in with a fingerprint, face, screen lock, or security key. A passkey signs you in on its own and counts as two-step verification."
        actions={
          status.passkeysAvailable &&
          supported && (
            <Button
              variant="primary"
              loading={register.isPending}
              onClick={() => register.mutate()}
            >
              Add a passkey
            </Button>
          )
        }
      />
      {!status.passkeysAvailable && (
        <div className="notice notice--info">
          <strong>Passkeys are unavailable on this installation.</strong>
          <p>{status.passkeysUnavailableReason}</p>
        </div>
      )}
      {status.passkeysAvailable && !supported && (
        <div className="notice notice--info">
          This browser does not support passkeys.
        </div>
      )}
      {errorNotice(
        isPasskeyCancellation(register.error) ? null : register.error,
      )}
      {errorNotice(rename.error)}
      {errorNotice(remove.error)}

      {status.passkeys.length === 0 ? (
        <p className="security-status">No passkeys</p>
      ) : (
        <ul className="security-list">
          {status.passkeys.map((passkey) => (
            <li key={passkey.id}>
              <span className="security-list__name">{passkey.name}</span>
              <span className="security-list__meta">
                Added {new Date(passkey.createdAt).toLocaleDateString()}
                {passkey.lastUsedAt
                  ? ` · Last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
                  : " · Never used"}
              </span>
              <span className="security-list__actions">
                <Button
                  compact
                  onClick={() => {
                    setRenaming(passkey);
                    setName(passkey.name);
                  }}
                >
                  Rename
                </Button>
                <Button
                  variant="danger"
                  compact
                  onClick={() => setRemoving(passkey)}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {renaming && (
        <div className="security-enroll security-enroll--stacked">
          <FormField
            id="passkey-name"
            label={`Rename “${renaming.name}”`}
            hint="Tilecast named this from the authenticator that created it."
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="security-actions">
            <Button
              variant="primary"
              loading={rename.isPending}
              onClick={() => rename.mutate()}
            >
              Save
            </Button>
            <Button variant="quiet" onClick={() => setRenaming(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {removing && (
        <PasswordConfirm
          id="passkey-remove"
          label={`Confirm your password to remove “${removing.name}”`}
          value={password}
          onChange={setPassword}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setRemoving(undefined)}
        />
      )}
    </Panel>
  );
}

function RecoveryCodePanel({ status }: { status: SecurityStatus }) {
  const { status: auth } = useAuth();
  const csrfToken = auth?.csrfToken ?? "";
  const refresh = useSecurityRefresh();
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [codes, setCodes] = useState<string[]>();

  const generate = useMutation({
    mutationFn: () => api.regenerateRecoveryCodes(password, csrfToken),
    onSuccess: (result) => {
      setConfirming(false);
      setPassword("");
      setCodes(result.codes);
      refresh();
    },
  });

  return (
    <Panel>
      <SectionHeader
        title="Recovery codes"
        level={3}
        description="Single-use codes that let you sign in when you cannot reach your authenticator or passkey."
        actions={
          <Button onClick={() => setConfirming((open) => !open)}>
            {status.recoveryCodesRemaining > 0 ? "Regenerate" : "Generate"}
          </Button>
        }
      />
      <p className="security-status">
        {status.recoveryCodesRemaining > 0
          ? `${status.recoveryCodesRemaining} unused ${status.recoveryCodesRemaining === 1 ? "code" : "codes"} remaining`
          : "No recovery codes"}
      </p>
      {errorNotice(generate.error)}

      {confirming && (
        <PasswordConfirm
          id="recovery-generate"
          label="Confirm your password to generate new codes"
          hint="Any existing recovery codes stop working."
          value={password}
          onChange={setPassword}
          pending={generate.isPending}
          onConfirm={() => generate.mutate()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {codes && (
        <div className="security-codes">
          <div className="notice notice--warning">
            <strong>These codes are shown once.</strong>
            <p>
              Save them somewhere safe now. Tilecast stores only their hashes
              and cannot show them again.
            </p>
          </div>
          <ul>
            {codes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <div className="security-actions">
            <Button
              onClick={() =>
                void navigator.clipboard?.writeText(codes.join("\n"))
              }
            >
              Copy all
            </Button>
            <Button variant="quiet" onClick={() => setCodes(undefined)}>
              I have saved them
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function PasswordConfirm({
  id,
  label,
  hint,
  value,
  onChange,
  pending,
  onConfirm,
  onCancel,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="security-enroll security-enroll--stacked">
      <FormField
        id={id}
        label={label}
        hint={hint}
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="security-actions">
        <Button variant="primary" loading={pending} onClick={onConfirm}>
          Confirm
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function errorNotice(error: Error | null | undefined) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? error.message
      : "Tilecast could not complete the request.";
  return (
    <div className="notice notice--error" role="alert">
      {message}
    </div>
  );
}
