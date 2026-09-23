import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Check } from "lucide-react";
import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import type { SecurityStatus } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  isPasskeyCancellation,
  passkeysSupported,
  serializeRegistration,
  toCreationOptions,
} from "../auth/webauthn";
import { Brand } from "../components/Brand";
import { FormField } from "../components/FormField";
import { SecurityQr } from "../components/SecurityQr";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { securityKey } from "./SecurityPage";

/**
 * The guided first sign-in. A session that owes the organization a factor
 * cannot reach any other page, so this replaces the shell entirely and walks
 * one step at a time instead of presenting the whole My Account page and
 * leaving the user to work out the order.
 */
export function EnrollmentWizard({ onFinish }: { onFinish: () => void }) {
  const security = useQuery({ queryKey: securityKey, queryFn: api.security });
  const { t } = useTranslation(["auth", "common"]);
  if (security.isLoading)
    return (
      <Frame>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-label={t("status.loading")} />
          {t("enrollment.preparing")}
        </p>
      </Frame>
    );
  if (!security.data)
    return (
      <Frame>
        <Alert variant="destructive">
          <AlertDescription>{t("enrollment.loadError")}</AlertDescription>
        </Alert>
      </Frame>
    );
  return <Wizard status={security.data} onFinish={onFinish} />;
}

type Step = "authenticator" | "recovery" | "passkey";
type Screen = "welcome" | Step | "done";

const stepOrder: readonly Step[] = ["authenticator", "recovery", "passkey"];
// Step names are stored as locale keys and translated at render.
const stepLabelKeys = {
  authenticator: "enrollment.steps.authenticator",
  recovery: "enrollment.steps.recovery",
  passkey: "enrollment.steps.passkey",
} as const;

function Wizard({
  status,
  onFinish,
}: {
  status: SecurityStatus;
  onFinish: () => void;
}) {
  const { status: auth, logout } = useAuth();
  const { t } = useTranslation(["auth", "common"]);
  const [screen, setScreen] = useState<Screen>("welcome");
  const [done, setDone] = useState<readonly Step[]>([]);
  // The plan is fixed when the wizard opens. Recomputing it as factors are
  // added would delete steps from the progress list the moment they are
  // finished, so the user would watch the plan shrink under them.
  const [plan] = useState<readonly Step[]>(() =>
    stepOrder.filter((step) => {
      if (step === "authenticator") return !status.totpEnrolled;
      if (step === "recovery") return status.recoveryCodesRemaining === 0;
      return (
        status.passkeysAvailable &&
        passkeysSupported() &&
        status.passkeys.length === 0
      );
    }),
  );

  const firstName = (auth?.user?.name ?? "").trim().split(/\s+/)[0];
  function advance(from: Step | "welcome", completed?: Step) {
    if (completed) setDone((steps) => [...steps, completed]);
    const at = from === "welcome" ? -1 : plan.indexOf(from);
    setScreen(plan[at + 1] ?? "done");
  }

  return (
    <Frame>
      {screen === "welcome" && (
        <WelcomeScreen
          firstName={firstName}
          plan={plan}
          onStart={() => advance("welcome")}
        />
      )}
      {screen !== "welcome" && screen !== "done" && (
        <Progress plan={plan} current={screen} done={done} />
      )}
      {screen === "authenticator" && (
        <AuthenticatorStep onDone={() => advance("authenticator", screen)} />
      )}
      {screen === "recovery" && (
        <RecoveryStep
          onDone={() => advance("recovery", screen)}
          onSkip={() => advance("recovery")}
        />
      )}
      {screen === "passkey" && (
        <PasskeyStep
          onDone={() => advance("passkey", screen)}
          onSkip={() => advance("passkey")}
        />
      )}
      {screen === "done" && (
        <DoneScreen firstName={firstName} status={status} onFinish={onFinish} />
      )}
      {screen !== "done" && (
        <footer className="border-t border-border pt-2">
          <Button variant="ghost" onClick={() => void logout()}>
            {t("enrollment.signOut")}
          </Button>
        </footer>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-start justify-center bg-background px-[clamp(1rem,5vw,3rem)] py-[clamp(1rem,5vw,3.5rem)]">
      <section className="grid w-full max-w-[34rem] content-start gap-[1.35rem] rounded-[var(--tc-radius-overlay)] border border-border bg-card p-[clamp(1.5rem,4vw,2.25rem)]">
        <div className="flex justify-center [&_.brand__studio-logo]:h-auto [&_.brand__studio-logo]:w-[min(10.5rem,60%)]">
          <Brand compact />
        </div>
        {children}
      </section>
    </main>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 text-[0.74rem] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
      {children}
    </p>
  );
}

function IntroHeader({
  eyebrow,
  title,
  lede,
  step = false,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede: ReactNode;
  step?: boolean;
}) {
  return (
    <header className="grid gap-2">
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h1
        className={`m-0 leading-[1.2] font-semibold ${step ? "text-xl" : "text-[1.55rem]"}`}
      >
        {title}
      </h1>
      <p className="m-0 text-[0.92rem] leading-[1.5] text-muted-foreground">
        {lede}
      </p>
    </header>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function LoadingButton({
  loading,
  children,
  ...props
}: ComponentProps<typeof Button> & { loading?: boolean }) {
  return (
    <Button
      disabled={loading ?? props.disabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner /> : null}
      {children}
    </Button>
  );
}

function WelcomeScreen({
  firstName,
  plan,
  onStart,
}: {
  firstName?: string;
  plan: readonly Step[];
  onStart: () => void;
}) {
  const { t } = useTranslation(["auth", "common"]);
  const blurbKeys = {
    authenticator: "enrollment.welcome.blurbs.authenticator",
    recovery: "enrollment.welcome.blurbs.recovery",
    passkey: "enrollment.welcome.blurbs.passkey",
  } as const;
  return (
    <>
      <IntroHeader
        eyebrow={t("enrollment.welcome.eyebrow")}
        title={
          firstName
            ? t("enrollment.welcome.titleNamed", { name: firstName })
            : t("enrollment.welcome.titleAnonymous")
        }
        lede={t("enrollment.welcome.description")}
      />
      {plan.length > 0 && (
        <ol className="m-0 grid list-none gap-2 p-0">
          {plan.map((step, index) => (
            <li
              key={step}
              className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-[var(--tc-radius-control)] border border-border px-3 py-2.5"
            >
              <span
                className="grid size-[1.45rem] place-items-center rounded-full bg-muted text-[0.8rem] font-semibold text-muted-foreground"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <span className="grid gap-0.5">
                <strong className="text-sm font-semibold">
                  {t(stepLabelKeys[step])}
                </strong>
                <small className="text-[0.82rem] text-muted-foreground">
                  {t(blurbKeys[step])}
                </small>
              </span>
            </li>
          ))}
        </ol>
      )}
      <Actions>
        <Button onClick={onStart}>
          {plan.length > 0
            ? t("enrollment.welcome.start")
            : t("enrollment.welcome.continue")}
        </Button>
      </Actions>
    </>
  );
}

function Progress({
  plan,
  current,
  done,
}: {
  plan: readonly Step[];
  current: Step;
  done: readonly Step[];
}) {
  const { t } = useTranslation(["auth", "common"]);
  const position = plan.indexOf(current) + 1;
  return (
    <nav className="grid gap-2" aria-label={t("enrollment.progress.label")}>
      <Eyebrow>
        {t("enrollment.progress.position", {
          position,
          total: plan.length,
        })}
      </Eyebrow>
      <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {plan.map((step) => (
          <li
            key={step}
            aria-current={step === current ? "step" : undefined}
            data-state={
              done.includes(step)
                ? "done"
                : step === current
                  ? "current"
                  : "todo"
            }
            className="flex items-center gap-1.5 rounded-[var(--tc-radius-control)] border border-transparent bg-muted px-2 py-1 text-[0.78rem] text-muted-foreground data-[state=current]:border-[var(--tc-border-strong,var(--border))] data-[state=current]:font-semibold data-[state=current]:text-foreground"
          >
            {done.includes(step) && <Check size={13} aria-hidden="true" />}
            {t(stepLabelKeys[step])}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function AuthenticatorStep({ onDone }: { onDone: () => void }) {
  const { status: auth } = useAuth();
  const { t } = useTranslation(["auth", "common"]);
  const csrfToken = auth?.csrfToken ?? "";
  const refresh = useSecurityRefresh();
  const [code, setCode] = useState("");

  // The secret is requested as the step opens: a guided flow should not make
  // the user press "Set up" before there is anything to scan.
  const begin = useMutation({
    mutationFn: () => api.beginTotpEnrollment(csrfToken),
  });
  useEffect(() => {
    begin.mutate();
    // Enrollment is started exactly once per visit to this step; a repeat call
    // would issue a second secret and invalidate the code being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = useMutation({
    mutationFn: () => api.confirmTotpEnrollment(code, csrfToken),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });

  return (
    <>
      <IntroHeader
        step
        title={t("enrollment.authenticator.title")}
        lede={t("enrollment.authenticator.description")}
      />
      {errorNotice(begin.error ?? confirm.error, t)}
      {begin.data && (
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] max-sm:justify-items-center">
          <SecurityQr uri={begin.data.provisioningUri} />
          <div className="grid content-start gap-3 max-sm:justify-self-stretch">
            <p className="m-0 grid gap-1 text-[0.84rem] text-muted-foreground">
              <Trans
                i18nKey="enrollment.authenticator.manualKey"
                ns="auth"
                values={{ secret: begin.data.secret }}
                components={{
                  secretCode: (
                    <code className="rounded-[var(--tc-radius-control)] bg-muted px-2 py-1.5 font-mono text-[0.9rem] tracking-[0.08em] break-all" />
                  ),
                }}
              />
            </p>
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                confirm.mutate();
              }}
            >
              <FormField
                id="enroll-totp-code"
                label={t("enrollment.authenticator.codeLabel")}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <LoadingButton type="submit" loading={confirm.isPending}>
                {t("enrollment.authenticator.submit")}
              </LoadingButton>
            </form>
          </div>
        </div>
      )}
      {begin.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-label={t("status.loading")} />
          {t("enrollment.authenticator.creatingSecret")}
        </p>
      )}
    </>
  );
}

function RecoveryStep({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const { status: auth } = useAuth();
  const { t } = useTranslation(["auth", "common"]);
  const csrfToken = auth?.csrfToken ?? "";
  const refresh = useSecurityRefresh();
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[]>();
  const [copied, setCopied] = useState(false);

  const generate = useMutation({
    mutationFn: () => api.regenerateRecoveryCodes(password, csrfToken),
    onSuccess: (result) => {
      setPassword("");
      setCodes(result.codes);
      refresh();
    },
  });

  return (
    <>
      <IntroHeader
        step
        title={t("enrollment.recovery.title")}
        lede={t("enrollment.recovery.description")}
      />
      {errorNotice(generate.error, t)}
      {!codes ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            generate.mutate();
          }}
        >
          <FormField
            id="enroll-recovery-password"
            label={t("enrollment.recovery.passwordLabel")}
            hint={t("enrollment.recovery.passwordHint")}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Actions>
            <LoadingButton type="submit" loading={generate.isPending}>
              {t("enrollment.recovery.submit")}
            </LoadingButton>
            <Button variant="ghost" type="button" onClick={onSkip}>
              {t("enrollment.recovery.skip")}
            </Button>
          </Actions>
        </form>
      ) : (
        <div className="grid gap-3">
          <Alert>
            <AlertTitle>{t("enrollment.recovery.shownOnceTitle")}</AlertTitle>
            <AlertDescription>
              {t("enrollment.recovery.shownOnceDescription")}
            </AlertDescription>
          </Alert>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-1.5 p-0">
            {codes.map((code) => (
              <li key={code}>
                <code className="block rounded-[var(--tc-radius-control)] border border-border bg-muted px-2 py-1.5 text-center font-mono text-[0.92rem] tracking-[0.06em]">
                  {code}
                </code>
              </li>
            ))}
          </ul>
          <Actions>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(codes.join("\n"));
                setCopied(true);
              }}
            >
              {copied
                ? t("enrollment.recovery.copied")
                : t("enrollment.recovery.copyAll")}
            </Button>
            <Button onClick={onDone}>{t("enrollment.recovery.saved")}</Button>
          </Actions>
        </div>
      )}
    </>
  );
}

function PasskeyStep({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const { status: auth } = useAuth();
  const { t } = useTranslation(["auth", "common"]);
  const csrfToken = auth?.csrfToken ?? "";
  const refresh = useSecurityRefresh();

  // No name is asked for. The user already answered a system prompt to get
  // here; the authenticator tells us what it is, and it can be renamed later.
  const register = useMutation({
    mutationFn: async () => {
      const ceremony = await api.passkeyRegistrationOptions(csrfToken);
      const credential = (await navigator.credentials.create({
        publicKey: toCreationOptions(ceremony.options),
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error(t("errors.noPasskeyCreated"));
      return api.registerPasskey(
        ceremony.challengeToken,
        serializeRegistration(credential),
        csrfToken,
      );
    },
    onSuccess: () => {
      refresh();
      onDone();
    },
  });

  return (
    <>
      <IntroHeader
        step
        title={t("enrollment.passkey.title")}
        lede={t("enrollment.passkey.description")}
      />
      {errorNotice(
        isPasskeyCancellation(register.error) ? null : register.error,
        t,
      )}
      <Actions>
        <LoadingButton
          loading={register.isPending}
          onClick={() => register.mutate()}
        >
          {t("enrollment.passkey.submit")}
        </LoadingButton>
        <Button variant="ghost" onClick={onSkip}>
          {t("enrollment.passkey.skip")}
        </Button>
      </Actions>
    </>
  );
}

function DoneScreen({
  firstName,
  status,
  onFinish,
}: {
  firstName?: string;
  status: SecurityStatus;
  onFinish: () => void;
}) {
  const client = useQueryClient();
  const { t } = useTranslation(["auth", "common"]);
  const summary = [
    status.totpEnrolled ? t("enrollment.done.authenticatorAdded") : null,
    status.recoveryCodesRemaining > 0
      ? t("enrollment.done.recoveryCodesIssued", {
          count: status.recoveryCodesRemaining,
        })
      : null,
    status.passkeys.length > 0
      ? t("enrollment.done.passkeyAdded", {
          name: status.passkeys[0]?.name,
        })
      : null,
  ].filter((line): line is string => Boolean(line));
  return (
    <>
      <IntroHeader
        eyebrow={t("enrollment.done.eyebrow")}
        title={
          firstName
            ? t("enrollment.done.titleNamed", { name: firstName })
            : t("enrollment.done.titleAnonymous")
        }
        lede={t("enrollment.done.description")}
      />
      {summary.length > 0 && (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {summary.map((line) => (
            <li key={line} className="flex items-center gap-2 text-sm">
              <Check size={15} aria-hidden="true" />
              {line}
            </li>
          ))}
        </ul>
      )}
      <Actions>
        <Button
          onClick={() => {
            // The gate lives on the session, so the dashboard only lets the
            // user through once the auth status has caught up.
            void client.invalidateQueries({ queryKey: ["auth", "status"] });
            onFinish();
          }}
        >
          {t("enrollment.done.enter")}
        </Button>
      </Actions>
    </>
  );
}

/**
 * Only the security query is refreshed between steps. Refreshing the auth
 * status here would clear the enrollment gate as soon as the first factor
 * exists and drop the user into the shell mid-wizard, before recovery codes
 * and a passkey were offered.
 */
function useSecurityRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: securityKey });
  };
}

function errorNotice(error: Error | null | undefined, t: TFunction<"auth">) {
  if (!error) return null;
  // Server failures render untouched; only the client-side fallback is ours.
  const message =
    error instanceof ApiError ? error.message : t("errors.requestFailed");
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
