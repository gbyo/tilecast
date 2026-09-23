import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
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
import { toast } from "../components/ui/toast";
import { securityKey } from "./SecurityPage";

/**
 * The guided first sign-in. A session that owes the organization a factor
 * cannot reach any other page, so this replaces the shell entirely and walks
 * one step at a time instead of presenting the whole My Account page and
 * leaving the user to work out the order.
 */
export function EnrollmentWizard({ onFinish }: { onFinish: () => void }) {
  const security = useQuery({ queryKey: securityKey, queryFn: api.security });
  if (security.isLoading)
    return (
      <Frame>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-label="Loading" />
          Preparing your account…
        </p>
      </Frame>
    );
  if (!security.data)
    return (
      <Frame>
        <Alert variant="destructive">
          <AlertDescription>
            Sign-in security could not be loaded. Reload the page to try again.
          </AlertDescription>
        </Alert>
      </Frame>
    );
  return <Wizard status={security.data} onFinish={onFinish} />;
}

type Step = "authenticator" | "recovery" | "passkey";
type Screen = "welcome" | Step | "done";

const stepOrder: readonly Step[] = ["authenticator", "recovery", "passkey"];
const stepLabels: Record<Step, string> = {
  authenticator: "Authenticator app",
  recovery: "Recovery codes",
  passkey: "Passkey",
};

function Wizard({
  status,
  onFinish,
}: {
  status: SecurityStatus;
  onFinish: () => void;
}) {
  const { status: auth, logout } = useAuth();
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
            Sign out instead
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
  const blurbs: Record<Step, string> = {
    authenticator: "Six-digit codes from an app on your phone.",
    recovery: "Printable codes that get you back in if you lose the app.",
    passkey:
      "Optional. Your fingerprint, face, or screen lock instead of a code.",
  };
  return (
    <>
      <IntroHeader
        eyebrow="Welcome to Tilecast Studio"
        title={firstName ? `Hello, ${firstName}.` : "Hello."}
        lede="This organization asks for a second step when you sign in. Setting it up takes about two minutes, and you only do it once."
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
                  {stepLabels[step]}
                </strong>
                <small className="text-[0.82rem] text-muted-foreground">
                  {blurbs[step]}
                </small>
              </span>
            </li>
          ))}
        </ol>
      )}
      <Actions>
        <Button onClick={onStart}>
          {plan.length > 0 ? "Get started" : "Continue"}
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
  const position = plan.indexOf(current) + 1;
  return (
    <nav className="grid gap-2" aria-label="Setup progress">
      <Eyebrow>
        Step {position} of {plan.length}
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
            {stepLabels[step]}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function AuthenticatorStep({ onDone }: { onDone: () => void }) {
  const { status: auth } = useAuth();
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
        title="Add your authenticator app"
        lede="Scan this code with an app such as Aegis, Google Authenticator, or 1Password, then type the six-digit code it shows."
      />
      {errorNotice(begin.error ?? confirm.error)}
      {begin.data && (
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] max-sm:justify-items-center">
          <SecurityQr uri={begin.data.provisioningUri} />
          <div className="grid content-start gap-3 max-sm:justify-self-stretch">
            <p className="m-0 grid gap-1 text-[0.84rem] text-muted-foreground">
              Cannot scan? Enter this key by hand:
              <code className="rounded-[var(--tc-radius-control)] bg-muted px-2 py-1.5 font-mono text-[0.9rem] tracking-[0.08em] break-all">
                {begin.data.secret}
              </code>
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
                label="Six-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <LoadingButton type="submit" loading={confirm.isPending}>
                Confirm and continue
              </LoadingButton>
            </form>
          </div>
        </div>
      )}
      {begin.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-label="Loading" />
          Creating a secret…
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
        title="Save your recovery codes"
        lede="These are how you get back in if you lose your phone. Tilecast has no email reset, so keep them somewhere you can reach without this account."
      />
      {errorNotice(generate.error)}
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
            label="Confirm your password"
            hint="Tilecast asks again before it issues codes."
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Actions>
            <LoadingButton type="submit" loading={generate.isPending}>
              Generate codes
            </LoadingButton>
            <Button variant="ghost" type="button" onClick={onSkip}>
              Skip for now
            </Button>
          </Actions>
        </form>
      ) : (
        <div className="grid gap-3">
          <Alert>
            <AlertTitle>These codes are shown once.</AlertTitle>
            <AlertDescription>
              Tilecast stores only their hashes and cannot show them again. Each
              code works one time.
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
                void navigator.clipboard
                  ?.writeText(codes.join("\n"))
                  .then(() => {
                    setCopied(true);
                    toast.add({
                      title: "Recovery codes copied.",
                      type: "success",
                    });
                  })
                  .catch(() =>
                    toast.add({
                      title: "Recovery codes could not be copied.",
                      type: "error",
                    }),
                  );
              }}
            >
              {copied ? "Copied" : "Copy all"}
            </Button>
            <Button onClick={onDone}>I have saved them</Button>
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
      if (!credential) throw new Error("No passkey was created.");
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
        title="Add a passkey"
        lede="A passkey signs you in with your fingerprint, face, or screen lock, with no code to type. It counts as your second step on its own. You can add one later from My Account instead."
      />
      {errorNotice(
        isPasskeyCancellation(register.error) ? null : register.error,
      )}
      <Actions>
        <LoadingButton
          loading={register.isPending}
          onClick={() => register.mutate()}
        >
          Add a passkey
        </LoadingButton>
        <Button variant="ghost" onClick={onSkip}>
          Not now
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
  const summary = [
    status.totpEnrolled ? "Authenticator app added" : null,
    status.recoveryCodesRemaining > 0
      ? `${status.recoveryCodesRemaining} recovery codes issued`
      : null,
    status.passkeys.length > 0
      ? `Passkey added — ${status.passkeys[0]?.name}`
      : null,
  ].filter((line): line is string => Boolean(line));
  return (
    <>
      <IntroHeader
        eyebrow="Sign-in security"
        title={firstName ? `You're set, ${firstName}.` : "You're set."}
        lede="Next time you sign in, Tilecast asks for your second step after your password. You can change any of this from My Account."
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
          Enter Tilecast Studio
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

function errorNotice(error: Error | null | undefined) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? error.message
      : "Tilecast could not complete the request.";
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
