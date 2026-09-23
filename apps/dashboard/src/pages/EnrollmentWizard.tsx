import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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
import { Button } from "../components/legacy-ui";
import { securityKey } from "./SecurityPage";
import "./EnrollmentWizard.css";

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
        <p className="table-loading">Preparing your account…</p>
      </Frame>
    );
  if (!security.data)
    return (
      <Frame>
        <div className="notice notice--error" role="alert">
          Sign-in security could not be loaded. Reload the page to try again.
        </div>
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
        <footer className="enrollment__footer">
          <Button variant="quiet" onClick={() => void logout()}>
            Sign out instead
          </Button>
        </footer>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="enrollment">
      <section className="enrollment__card">
        <div className="enrollment__logo">
          <Brand compact />
        </div>
        {children}
      </section>
    </main>
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
      <header className="enrollment__intro">
        <p className="enrollment__eyebrow">Welcome to Tilecast Studio</p>
        <h1>{firstName ? `Hello, ${firstName}.` : "Hello."}</h1>
        <p className="enrollment__lede">
          This organization asks for a second step when you sign in. Setting it
          up takes about two minutes, and you only do it once.
        </p>
      </header>
      {plan.length > 0 && (
        <ol className="enrollment__plan">
          {plan.map((step, index) => (
            <li key={step}>
              <span className="enrollment__plan-number" aria-hidden="true">
                {index + 1}
              </span>
              <span>
                <strong>{stepLabels[step]}</strong>
                <small>{blurbs[step]}</small>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="enrollment__actions">
        <Button variant="primary" onClick={onStart}>
          {plan.length > 0 ? "Get started" : "Continue"}
        </Button>
      </div>
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
    <nav className="enrollment__progress" aria-label="Setup progress">
      <p className="enrollment__eyebrow">
        Step {position} of {plan.length}
      </p>
      <ol>
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
      <header className="enrollment__step-header">
        <h1>Add your authenticator app</h1>
        <p>
          Scan this code with an app such as Aegis, Google Authenticator, or
          1Password, then type the six-digit code it shows.
        </p>
      </header>
      {errorNotice(begin.error ?? confirm.error)}
      {begin.data && (
        <div className="enrollment__scan">
          <SecurityQr uri={begin.data.provisioningUri} />
          <div className="enrollment__scan-copy">
            <p className="enrollment__secret">
              Cannot scan? Enter this key by hand:
              <code>{begin.data.secret}</code>
            </p>
            <form
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
              <Button
                variant="primary"
                type="submit"
                loading={confirm.isPending}
              >
                Confirm and continue
              </Button>
            </form>
          </div>
        </div>
      )}
      {begin.isPending && <p className="table-loading">Creating a secret…</p>}
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
      <header className="enrollment__step-header">
        <h1>Save your recovery codes</h1>
        <p>
          These are how you get back in if you lose your phone. Tilecast has no
          email reset, so keep them somewhere you can reach without this
          account.
        </p>
      </header>
      {errorNotice(generate.error)}
      {!codes ? (
        <form
          className="enrollment__confirm"
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
          <div className="enrollment__actions">
            <Button
              variant="primary"
              type="submit"
              loading={generate.isPending}
            >
              Generate codes
            </Button>
            <Button variant="quiet" type="button" onClick={onSkip}>
              Skip for now
            </Button>
          </div>
        </form>
      ) : (
        <div className="enrollment__codes">
          <div className="notice notice--warning">
            <strong>These codes are shown once.</strong>
            <p>
              Tilecast stores only their hashes and cannot show them again. Each
              code works one time.
            </p>
          </div>
          <ul>
            {codes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <div className="enrollment__actions">
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(codes.join("\n"));
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy all"}
            </Button>
            <Button variant="primary" onClick={onDone}>
              I have saved them
            </Button>
          </div>
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
      <header className="enrollment__step-header">
        <h1>Add a passkey</h1>
        <p>
          A passkey signs you in with your fingerprint, face, or screen lock,
          with no code to type. It counts as your second step on its own. You
          can add one later from My Account instead.
        </p>
      </header>
      {errorNotice(
        isPasskeyCancellation(register.error) ? null : register.error,
      )}
      <div className="enrollment__actions">
        <Button
          variant="primary"
          loading={register.isPending}
          onClick={() => register.mutate()}
        >
          Add a passkey
        </Button>
        <Button variant="quiet" onClick={onSkip}>
          Not now
        </Button>
      </div>
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
      <header className="enrollment__intro">
        <p className="enrollment__eyebrow">Sign-in security</p>
        <h1>{firstName ? `You're set, ${firstName}.` : "You're set."}</h1>
        <p className="enrollment__lede">
          Next time you sign in, Tilecast asks for your second step after your
          password. You can change any of this from My Account.
        </p>
      </header>
      {summary.length > 0 && (
        <ul className="enrollment__summary">
          {summary.map((line) => (
            <li key={line}>
              <Check size={15} aria-hidden="true" />
              {line}
            </li>
          ))}
        </ul>
      )}
      <div className="enrollment__actions">
        <Button
          variant="primary"
          onClick={() => {
            // The gate lives on the session, so the dashboard only lets the
            // user through once the auth status has caught up.
            void client.invalidateQueries({ queryKey: ["auth", "status"] });
            onFinish();
          }}
        >
          Enter Tilecast Studio
        </Button>
      </div>
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
    <div className="notice notice--error" role="alert">
      {message}
    </div>
  );
}
