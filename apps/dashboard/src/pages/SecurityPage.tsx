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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "../components/ui/input-otp";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";

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

/**
 * Sign-in methods as compact Item rows. Multi-element flows (the
 * authenticator QR/code step, passkey rename) expand inline beneath their
 * row; anything that needs a password confirmation or shows secrets once
 * interrupts in a Dialog instead.
 */
export function SecurityPanels({ status }: { status: SecurityStatus }) {
  return (
    <div className="grid gap-6">
      <AuthenticatorBlock status={status} />
      <PasskeyBlock status={status} />
      <RecoveryCodeBlock status={status} />
    </div>
  );
}

function AreaHeading({
  id,
  title,
  description,
  actions,
}: {
  id: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid gap-0.5">
        <h3 id={id} className="text-sm font-semibold">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {actions}
    </header>
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

function AuthenticatorBlock({ status }: { status: SecurityStatus }) {
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
    <section className="grid gap-3" aria-labelledby="security-authenticator">
      <AreaHeading
        id="security-authenticator"
        title="Authenticator app"
        description="A six-digit code from an app such as Aegis, Google Authenticator, or 1Password."
        actions={
          status.totpEnrolled ? (
            <Button variant="destructive" onClick={() => setRemoving(true)}>
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
      />
      <ItemGroup>
        <Item>
          <ItemContent>
            <ItemTitle>
              {status.totpEnrolled ? "Enrolled" : "Not enrolled"}
            </ItemTitle>
            {status.totpEnrolled && status.totpConfirmedAt && (
              <ItemDescription>
                Added {new Date(status.totpConfirmedAt).toLocaleDateString()}
              </ItemDescription>
            )}
          </ItemContent>
        </Item>
      </ItemGroup>
      {errorNotice(begin.error ?? confirm.error ?? remove.error)}

      {enrolling && begin.data && (
        <div className="grid gap-5 rounded-xl border border-border p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
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
            <div className="grid gap-2">
              <label htmlFor="totp-code" className="text-sm font-medium">
                Six-digit code
              </label>
              <InputOTP
                id="totp-code"
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={setCode}
              >
                <InputOTPGroup>
                  {Array.from({ length: 6 }, (_, index) => (
                    <InputOTPSlot key={index} index={index} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
            <div className="flex gap-2">
              <Button
                variant="default"
                disabled={confirm.isPending || code.length !== 6}
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

      <PasswordDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove authenticator"
        description="Confirm your password to remove the authenticator from this account."
        inputId="totp-remove"
        password={password}
        onPasswordChange={setPassword}
        pending={remove.isPending}
        error={remove.error}
        confirmLabel="Remove"
        destructive
        onConfirm={() => remove.mutate()}
      />
    </section>
  );
}

function PasskeyBlock({ status }: { status: SecurityStatus }) {
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
    <section className="grid gap-3" aria-labelledby="security-passkeys">
      <AreaHeading
        id="security-passkeys"
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
      />
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
        <ItemGroup>
          {status.passkeys.map((passkey) => (
            <Item key={passkey.id}>
              <ItemContent>
                <ItemTitle>{passkey.name}</ItemTitle>
                <ItemDescription>
                  Added {new Date(passkey.createdAt).toLocaleDateString()}
                  {passkey.lastUsedAt
                    ? ` · Last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
                    : " · Never used"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
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
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}

      {renaming && (
        <div className="grid max-w-md gap-3 rounded-xl border border-border p-4">
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

      <PasswordDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title={removing ? `Remove “${removing.name}”` : "Remove passkey"}
        description="Confirm your password to remove this passkey from this account."
        inputId="passkey-remove"
        password={password}
        onPasswordChange={setPassword}
        pending={remove.isPending}
        error={remove.error}
        confirmLabel="Remove"
        destructive
        onConfirm={() => remove.mutate()}
      />
    </section>
  );
}

function RecoveryCodeBlock({ status }: { status: SecurityStatus }) {
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
    <section className="grid gap-3" aria-labelledby="security-recovery">
      <AreaHeading
        id="security-recovery"
        title="Recovery codes"
        description="Single-use codes that let you sign in when you cannot reach your authenticator or passkey."
        actions={
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            {status.recoveryCodesRemaining > 0 ? "Regenerate" : "Generate"}
          </Button>
        }
      />
      <ItemGroup>
        <Item>
          <ItemContent>
            <ItemTitle>
              {status.recoveryCodesRemaining > 0
                ? `${status.recoveryCodesRemaining} unused ${status.recoveryCodesRemaining === 1 ? "code" : "codes"} remaining`
                : "No recovery codes"}
            </ItemTitle>
          </ItemContent>
        </Item>
      </ItemGroup>
      {errorNotice(generate.error)}

      <PasswordDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Generate recovery codes"
        description="Confirm your password to generate new codes. Any existing recovery codes stop working."
        inputId="recovery-generate"
        password={password}
        onPasswordChange={setPassword}
        pending={generate.isPending}
        error={generate.error}
        confirmLabel="Generate"
        onConfirm={() => generate.mutate()}
      />

      <Dialog
        open={Boolean(codes)}
        onOpenChange={(open) => {
          if (!open) setCodes(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>These codes are shown once.</DialogTitle>
            <DialogDescription>
              Save them somewhere safe now. Tilecast stores only their hashes
              and cannot show them again.
            </DialogDescription>
          </DialogHeader>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-1.5 p-0">
            {(codes ?? []).map((code) => (
              <li key={code}>
                <code className="block rounded-md border border-border bg-muted px-2 py-1.5 text-center font-mono text-sm tracking-wide">
                  {code}
                </code>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText((codes ?? []).join("\n"))
                  .then(() =>
                    toast.add({
                      title: "Recovery codes copied.",
                      type: "success",
                    }),
                  )
                  .catch(() =>
                    toast.add({
                      title: "Recovery codes could not be copied.",
                      type: "error",
                    }),
                  );
              }}
            >
              Copy all
            </Button>
            <Button variant="default" onClick={() => setCodes(undefined)}>
              I have saved them
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * Destructive and secret-issuing confirmations interrupt in a Dialog so the
 * password prompt cannot be scrolled past or submitted twice from two open
 * inline forms. Removing a factor or regenerating codes always requires the
 * account password in addition to the session.
 */
function PasswordDialog({
  open,
  onOpenChange,
  title,
  description,
  inputId,
  password,
  onPasswordChange,
  pending,
  error,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  inputId: string;
  password: string;
  onPasswordChange: (value: string) => void;
  pending: boolean;
  error: Error | null;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <FormField
          id={inputId}
          label="Account password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
        />
        {errorNotice(error)}
        <DialogFooter>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={pending || password.length === 0}
            onClick={onConfirm}
          >
            {pending && <Spinner aria-hidden="true" />}
            {confirmLabel}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
