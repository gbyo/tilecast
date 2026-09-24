import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
import { useFormatLocale } from "../i18n";

export const securityKey = ["me", "security"] as const;

export function SecurityPage() {
  const { t } = useTranslation(["account", "common"]);
  const security = useQuery({ queryKey: securityKey, queryFn: api.security });
  if (security.isLoading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" /> {t("security.loading")}
      </p>
    );
  if (!security.data)
    return (
      <Alert variant="destructive">
        <AlertDescription role="alert">
          {t("security.loadError")}
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
  const { t } = useTranslation(["account", "common"]);
  const locale = useFormatLocale();
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
        title={t("security.authenticator.title")}
        description={t("security.authenticator.description")}
        actions={
          status.totpEnrolled ? (
            <Button variant="destructive" onClick={() => setRemoving(true)}>
              {t("common:actions.remove")}
            </Button>
          ) : (
            <Button
              variant="default"
              disabled={begin.isPending}
              onClick={() => begin.mutate()}
            >
              {begin.isPending && <Spinner aria-hidden="true" />}
              {t("security.authenticator.setup")}
            </Button>
          )
        }
      />
      <ItemGroup>
        <Item>
          <ItemContent>
            <ItemTitle>
              {status.totpEnrolled
                ? t("security.authenticator.enrolled")
                : t("security.authenticator.notEnrolled")}
            </ItemTitle>
            {status.totpEnrolled && status.totpConfirmedAt && (
              <ItemDescription>
                {t("security.authenticator.addedOn", {
                  date: new Date(status.totpConfirmedAt).toLocaleDateString(
                    locale,
                  ),
                })}
              </ItemDescription>
            )}
          </ItemContent>
        </Item>
      </ItemGroup>
      {errorNotice(
        begin.error ?? confirm.error ?? remove.error,
        t("security.errors.requestFailed"),
      )}

      {enrolling && begin.data && (
        <div className="grid gap-5 rounded-xl border border-border p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          <SecurityQr uri={begin.data.provisioningUri} />
          <div className="grid content-start gap-3">
            <p className="m-0 text-sm">
              {t("security.authenticator.enrollInstruction")}
            </p>
            <p className="m-0 grid gap-1 text-sm text-muted-foreground">
              {t("security.authenticator.manualKeyLabel")}
              <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm tracking-wider break-all">
                {begin.data.secret}
              </code>
            </p>
            <div className="grid gap-2">
              <label htmlFor="totp-code" className="text-sm font-medium">
                {t("security.authenticator.codeLabel")}
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
                {t("common:actions.confirm")}
              </Button>
              <Button variant="ghost" onClick={() => setEnrolling(false)}>
                {t("common:actions.cancel")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <PasswordDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("security.authenticator.removeTitle")}
        description={t("security.authenticator.removeDescription")}
        inputId="totp-remove"
        password={password}
        onPasswordChange={setPassword}
        pending={remove.isPending}
        error={remove.error}
        confirmLabel={t("common:actions.remove")}
        destructive
        onConfirm={() => remove.mutate()}
      />
    </section>
  );
}

function PasskeyBlock({ status }: { status: SecurityStatus }) {
  const { t } = useTranslation(["account", "common"]);
  const locale = useFormatLocale();
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
      if (!credential) throw new Error(t("security.passkeys.notCreated"));
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
      if (!renaming) throw new Error(t("security.passkeys.selectToRename"));
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
      if (!removing) throw new Error(t("security.passkeys.selectToRemove"));
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
        title={t("security.passkeys.title")}
        description={t("security.passkeys.description")}
        actions={
          status.passkeysAvailable &&
          supported && (
            <Button
              variant="default"
              disabled={register.isPending}
              onClick={() => register.mutate()}
            >
              {register.isPending && <Spinner aria-hidden="true" />}
              {t("security.passkeys.add")}
            </Button>
          )
        }
      />
      {!status.passkeysAvailable && (
        <Alert>
          <AlertTitle>{t("security.passkeys.unavailableTitle")}</AlertTitle>
          <AlertDescription>
            {status.passkeysUnavailableReason}
          </AlertDescription>
        </Alert>
      )}
      {status.passkeysAvailable && !supported && (
        <Alert>
          <AlertDescription>
            {t("security.passkeys.browserUnsupported")}
          </AlertDescription>
        </Alert>
      )}
      {errorNotice(
        isPasskeyCancellation(register.error) ? null : register.error,
        t("security.errors.requestFailed"),
      )}
      {errorNotice(rename.error, t("security.errors.requestFailed"))}
      {errorNotice(remove.error, t("security.errors.requestFailed"))}

      {status.passkeys.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          {t("security.passkeys.empty")}
        </p>
      ) : (
        <ItemGroup>
          {status.passkeys.map((passkey) => (
            <Item key={passkey.id}>
              <ItemContent>
                <ItemTitle>{passkey.name}</ItemTitle>
                <ItemDescription>
                  {t("security.passkeys.addedOn", {
                    date: new Date(passkey.createdAt).toLocaleDateString(
                      locale,
                    ),
                  })}
                  {passkey.lastUsedAt
                    ? ` · ${t("security.passkeys.lastUsed", {
                        date: new Date(passkey.lastUsedAt).toLocaleDateString(
                          locale,
                        ),
                      })}`
                    : ` · ${t("security.passkeys.neverUsed")}`}
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
                  {t("security.passkeys.rename")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setRemoving(passkey)}
                >
                  {t("common:actions.remove")}
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
            label={t("security.passkeys.renameTitle", {
              name: renaming.name,
            })}
            hint={t("security.passkeys.renameHint")}
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
              {t("common:actions.save")}
            </Button>
            <Button variant="ghost" onClick={() => setRenaming(undefined)}>
              {t("common:actions.cancel")}
            </Button>
          </div>
        </div>
      )}

      <PasswordDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title={
          removing
            ? t("security.passkeys.removeTitle", { name: removing.name })
            : t("security.passkeys.removeFallbackTitle")
        }
        description={t("security.passkeys.removeDescription")}
        inputId="passkey-remove"
        password={password}
        onPasswordChange={setPassword}
        pending={remove.isPending}
        error={remove.error}
        confirmLabel={t("common:actions.remove")}
        destructive
        onConfirm={() => remove.mutate()}
      />
    </section>
  );
}

function RecoveryCodeBlock({ status }: { status: SecurityStatus }) {
  const { t } = useTranslation(["account", "common"]);
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
        title={t("security.recovery.title")}
        description={t("security.recovery.description")}
        actions={
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            {status.recoveryCodesRemaining > 0
              ? t("security.recovery.regenerate")
              : t("security.recovery.generate")}
          </Button>
        }
      />
      <ItemGroup>
        <Item>
          <ItemContent>
            <ItemTitle>
              {status.recoveryCodesRemaining > 0
                ? t("security.recovery.remaining", {
                    count: status.recoveryCodesRemaining,
                  })
                : t("security.recovery.empty")}
            </ItemTitle>
          </ItemContent>
        </Item>
      </ItemGroup>
      {errorNotice(generate.error, t("security.errors.requestFailed"))}

      <PasswordDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("security.recovery.dialogTitle")}
        description={t("security.recovery.dialogDescription")}
        inputId="recovery-generate"
        password={password}
        onPasswordChange={setPassword}
        pending={generate.isPending}
        error={generate.error}
        confirmLabel={t("security.recovery.generate")}
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
            <DialogTitle>{t("security.recovery.shownOnceTitle")}</DialogTitle>
            <DialogDescription>
              {t("security.recovery.shownOnceDescription")}
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
              {t("security.recovery.copyAll")}
            </Button>
            <Button variant="default" onClick={() => setCodes(undefined)}>
              {t("security.recovery.savedConfirm")}
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
  const { t } = useTranslation(["account", "common"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <FormField
          id={inputId}
          label={t("security.passwordDialog.passwordLabel")}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
        />
        {errorNotice(error, t("security.errors.requestFailed"))}
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
            {t("common:actions.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function errorNotice(error: Error | null | undefined, fallback: string) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : fallback;
  return (
    <Alert variant="destructive">
      <AlertDescription role="alert">{message}</AlertDescription>
    </Alert>
  );
}
