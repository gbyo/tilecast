import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
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
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";

export const securityKey = ["me", "security"] as const;

export function SecurityPage() {
  const security = useQuery({ queryKey: securityKey, queryFn: api.security });
  if (security.isLoading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" /> Loading sign-in security…
      </p>
    );
  if (!security.data)
    return (
      <Alert variant="destructive">
        <AlertDescription role="alert">
          Sign-in security could not be loaded.
        </AlertDescription>
      </Alert>
    );
  return <SecurityPanels status={security.data} />;
}

export function SecurityPanels({ status }: { status: SecurityStatus }) {
  return (
    <section className="grid gap-4">
      <AuthenticatorPanel status={status} />
      <PasskeyPanel status={status} />
      <RecoveryCodePanel status={status} />
    </section>
  );
}

function PanelSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {actions}
      </header>
      {children}
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
    <PanelSection
      title="Authenticator app"
      description="A six-digit code from an app such as Aegis, Google Authenticator, or 1Password."
      actions={
        status.totpEnrolled ? (
          <Button
            variant="destructive"
            onClick={() => setRemoving((open) => !open)}
          >
            Remove
          </Button>
        ) : (
          <Button
            variant="default"
            disabled={begin.isPending}
            onClick={() => begin.mutate()}
          >
            {begin.isPending && <Spinner aria-hidden="true" />}
            Set up
          </Button>
        )
      }
    >
      <p className="m-0 text-sm text-muted-foreground">
        {status.totpEnrolled ? (
          <>
            <strong className="font-semibold text-foreground">Enrolled</strong>
            {status.totpConfirmedAt &&
              ` — added ${new Date(status.totpConfirmedAt).toLocaleDateString()}`}
          </>
        ) : (
          "Not enrolled"
        )}
      </p>
      {errorNotice(begin.error ?? confirm.error ?? remove.error)}

      {enrolling && begin.data && (
        <div className="grid gap-5 border-t border-border pt-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          <SecurityQr uri={begin.data.provisioningUri} />
          <div className="grid content-start gap-3">
            <p className="m-0 text-sm">
              Scan the code with your authenticator app, then enter the
              six-digit code it shows.
            </p>
            <p className="m-0 grid gap-1 text-sm text-muted-foreground">
              Cannot scan? Enter this key by hand:
              <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm tracking-wider break-all">
                {begin.data.secret}
              </code>
            </p>
            <FormField
              id="totp-code"
              label="Six-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                variant="default"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate()}
              >
                {confirm.isPending && <Spinner aria-hidden="true" />}
                Confirm
              </Button>
              <Button variant="ghost" onClick={() => setEnrolling(false)}>
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
    </PanelSection>
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
    <PanelSection
      title="Passkeys"
      description="Sign in with a fingerprint, face, screen lock, or security key. A passkey signs you in on its own and counts as two-step verification."
      actions={
        status.passkeysAvailable &&
        supported && (
          <Button
            variant="default"
            disabled={register.isPending}
            onClick={() => register.mutate()}
          >
            {register.isPending && <Spinner aria-hidden="true" />}
            Add a passkey
          </Button>
        )
      }
    >
      {!status.passkeysAvailable && (
        <Alert>
          <AlertTitle>
            Passkeys are unavailable on this installation.
          </AlertTitle>
          <AlertDescription>
            {status.passkeysUnavailableReason}
          </AlertDescription>
        </Alert>
      )}
      {status.passkeysAvailable && !supported && (
        <Alert>
          <AlertDescription>
            This browser does not support passkeys.
          </AlertDescription>
        </Alert>
      )}
      {errorNotice(
        isPasskeyCancellation(register.error) ? null : register.error,
      )}
      {errorNotice(rename.error)}
      {errorNotice(remove.error)}

      {status.passkeys.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">No passkeys</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {status.passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-md border border-border px-3 py-2.5"
            >
              <span className="text-sm font-semibold">{passkey.name}</span>
              <span className="col-start-1 text-xs text-muted-foreground">
                Added {new Date(passkey.createdAt).toLocaleDateString()}
                {passkey.lastUsedAt
                  ? ` · Last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
                  : " · Never used"}
              </span>
              <span className="col-start-2 flex gap-1.5 row-span-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setRenaming(passkey);
                    setName(passkey.name);
                  }}
                >
                  Rename
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
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
        <div className="grid max-w-md gap-3 border-t border-border pt-4">
          <FormField
            id="passkey-name"
            label={`Rename “${renaming.name}”`}
            hint="Tilecast named this from the authenticator that created it."
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="default"
              disabled={rename.isPending}
              onClick={() => rename.mutate()}
            >
              {rename.isPending && <Spinner aria-hidden="true" />}
              Save
            </Button>
            <Button variant="ghost" onClick={() => setRenaming(undefined)}>
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
    </PanelSection>
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
    <PanelSection
      title="Recovery codes"
      description="Single-use codes that let you sign in when you cannot reach your authenticator or passkey."
      actions={
        <Button
          variant="secondary"
          onClick={() => setConfirming((open) => !open)}
        >
          {status.recoveryCodesRemaining > 0 ? "Regenerate" : "Generate"}
        </Button>
      }
    >
      <p className="m-0 text-sm text-muted-foreground">
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
        <div className="grid gap-3 border-t border-border pt-4">
          <Alert>
            <AlertTitle>These codes are shown once.</AlertTitle>
            <AlertDescription>
              Save them somewhere safe now. Tilecast stores only their hashes
              and cannot show them again.
            </AlertDescription>
          </Alert>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-1.5 p-0">
            {codes.map((code) => (
              <li key={code}>
                <code className="block rounded-md border border-border bg-muted px-2 py-1.5 text-center font-mono text-sm tracking-wide">
                  {code}
                </code>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                void navigator.clipboard?.writeText(codes.join("\n"))
              }
            >
              Copy all
            </Button>
            <Button variant="ghost" onClick={() => setCodes(undefined)}>
              I have saved them
            </Button>
          </div>
        </div>
      )}
    </PanelSection>
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
    <div className="grid max-w-md gap-3 border-t border-border pt-4">
      <FormField
        id={id}
        label={label}
        hint={hint}
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="flex gap-2">
        <Button variant="default" disabled={pending} onClick={onConfirm}>
          {pending && <Spinner aria-hidden="true" />}
          Confirm
        </Button>
        <Button variant="ghost" onClick={onCancel}>
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
    <Alert variant="destructive">
      <AlertDescription role="alert">{message}</AlertDescription>
    </Alert>
  );
}
