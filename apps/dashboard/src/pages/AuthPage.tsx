import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import {
  loginSchema,
  mfaSchema,
  setupSchema,
  type LoginForm,
  type MFAForm,
  type SetupForm,
} from "../auth/schemas";
import { passkeysSupported } from "../auth/webauthn";
import { Brand } from "../components/Brand";
import { FormField } from "../components/FormField";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";

export function AuthPage({ mode }: { mode: "setup" | "login" }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const requestedReturn = new URLSearchParams(location.search).get("returnTo");
  const returnTo =
    requestedReturn?.startsWith("/") && !requestedReturn.startsWith("//")
      ? requestedReturn
      : "/";
  useEffect(() => {
    if (auth.status?.authenticated) void navigate(returnTo, { replace: true });
    else if (auth.status && mode === "setup" && !auth.status.setupRequired)
      void navigate("/login", { replace: true });
    else if (auth.status?.setupRequired && mode === "login")
      void navigate("/setup", { replace: true });
  }, [auth.status, mode, navigate, returnTo]);

  if (auth.isLoading) return <LoadingScreen />;
  return (
    <main className="fixed inset-0 z-0 flex w-screen min-h-svh items-center justify-center overflow-hidden bg-[#1b2430] bg-[url('/api/v1/auth/background')] bg-cover bg-center p-[clamp(1rem,4vw,3rem)] max-[620px]:bg-[position:58%_center] max-[620px]:p-[0.85rem]">
      <div
        className="pointer-events-none absolute inset-0 bg-[rgb(7_12_18/42%)]"
        aria-hidden="true"
      />
      <section
        className={`relative z-[1] w-full flex-none rounded-[var(--tc-radius-overlay)] border border-[#d0d7de] bg-white px-[2.35rem] py-9 shadow-[0_20px_48px_rgb(0_0_0/28%)] max-[620px]:max-h-[calc(100svh-1.7rem)] max-[620px]:overflow-y-auto max-[620px]:px-[1.35rem] max-[620px]:py-7 ${mode === "setup" ? "max-w-[38rem]" : "max-w-[27rem]"} max-[620px]:max-w-full`}
      >
        <div className="mb-8 flex justify-center max-[620px]:mb-[1.45rem] [&_.brand__studio-logo]:h-auto [&_.brand__studio-logo]:w-[min(11.75rem,72%)] [&_.brand__studio-logo]:brightness-0">
          <Brand compact />
        </div>
        {mode === "setup" ? (
          <SetupFormView />
        ) : auth.challenge ? (
          <ChallengeFormView />
        ) : (
          <LoginFormView />
        )}
      </section>
    </main>
  );
}

function AuthHeader({
  id,
  title,
  body,
}: {
  id: string;
  title: string;
  body: string;
}) {
  return (
    <header className="mb-[1.6rem] text-center">
      <h1
        id={id}
        className="m-0 text-[1.7rem] leading-[1.18] font-[680] tracking-normal text-[#101316]"
      >
        {title}
      </h1>
      <p className="mt-2 text-[0.92rem] text-[#687078]">{body}</p>
    </header>
  );
}

function AuthError({ message }: { message: string }) {
  return (
    <Alert
      variant="destructive"
      className="mb-[1.15rem] border-[#e8c4c4] bg-[#fdf0f0] text-[#8f1d1d]"
    >
      <AlertDescription className="text-[#8f1d1d]">{message}</AlertDescription>
    </Alert>
  );
}

function AuthDivider({ children }: { children: string }) {
  return (
    <p className="my-[1.05rem] flex items-center gap-[0.7rem] text-[0.74rem] tracking-[0.06em] text-[#91979d] uppercase before:h-px before:flex-1 before:bg-[#e2e5e8] before:content-[''] after:h-px after:flex-1 after:bg-[#e2e5e8] after:content-['']">
      {children}
    </p>
  );
}

function SetupFormView() {
  const { setup, error, isSubmitting } = useAuth();
  const form = useForm<SetupForm>({
    resolver: zodResolver(setupSchema),
    defaultValues: {
      organizationName: "",
      ownerName: "",
      username: "",
      password: "",
      confirmPassword: "",
    },
  });
  const submit = form.handleSubmit(async (values) => {
    await setup({
      organizationName: values.organizationName,
      ownerName: values.ownerName,
      username: values.username,
      password: values.password,
    });
  });
  return (
    <div aria-labelledby="setup-title">
      <AuthHeader
        id="setup-title"
        title="Set up Tilecast"
        body="Create the first owner account for this installation."
      />
      {error && <AuthError message={error.message} />}
      <form
        onSubmit={(event) => void submit(event)}
        noValidate
        className="grid gap-[1.05rem]"
      >
        <FormField
          id="organizationName"
          label="Organization name"
          autoComplete="organization"
          error={form.formState.errors.organizationName?.message}
          {...form.register("organizationName")}
        />
        <FormField
          id="ownerName"
          label="Your name"
          autoComplete="name"
          error={form.formState.errors.ownerName?.message}
          {...form.register("ownerName")}
        />
        <FormField
          id="username"
          label="Email or username"
          autoComplete="username"
          error={form.formState.errors.username?.message}
          {...form.register("username")}
        />
        <div className="grid grid-cols-2 gap-[0.9rem] max-[620px]:grid-cols-1">
          <FormField
            id="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 12 characters"
            error={form.formState.errors.password?.message}
            {...form.register("password")}
          />
          <FormField
            id="confirmPassword"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            error={form.formState.errors.confirmPassword?.message}
            {...form.register("confirmPassword")}
          />
        </div>
        <Button
          type="submit"
          disabled={isSubmitting}
          className="mt-[0.35rem] min-h-[2.75rem] w-full"
        >
          {isSubmitting ? "Creating installation…" : "Create installation"}
        </Button>
      </form>
    </div>
  );
}

function LoginFormView() {
  const {
    login,
    loginWithPasskey,
    watchForPasskeyAutofill,
    error,
    isSubmitting,
    status,
  } = useAuth();
  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });
  const submit = form.handleSubmit(async (values) => {
    await login(values);
  });
  const autofillReady = Boolean(status?.passkeysAvailable);
  // Autofill-assisted sign-in has to be armed early in the page's life, before
  // the user reaches the username field, or the browser has nothing to offer
  // when they focus it.
  useEffect(() => {
    if (!autofillReady) return;
    return watchForPasskeyAutofill();
    // watchForPasskeyAutofill is recreated on every render; re-arming the
    // ceremony on each one would abort the pending request the user is about
    // to answer, so this intentionally depends only on availability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofillReady]);
  // The passkey button appears only when the installation can actually run a
  // ceremony. A plain-HTTP LAN server cannot, and offering a button that
  // always fails would be worse than not offering one.
  const passkeys = Boolean(status?.passkeysAvailable) && passkeysSupported();
  return (
    <div aria-labelledby="login-title">
      <AuthHeader
        id="login-title"
        title="Sign in"
        body="Manage your Tilecast displays."
      />
      {error && <AuthError message={error.message} />}
      <form
        onSubmit={(event) => void submit(event)}
        noValidate
        className="grid gap-[1.05rem]"
      >
        <FormField
          id="username"
          label="Email or username"
          autoComplete="username webauthn"
          autoFocus
          error={form.formState.errors.username?.message}
          {...form.register("username")}
        />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register("password")}
        />
        <Button
          type="submit"
          disabled={isSubmitting}
          className="mt-[0.35rem] min-h-[2.75rem] w-full"
        >
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      {passkeys && (
        <>
          <AuthDivider>or</AuthDivider>
          <Button
            variant="outline"
            type="button"
            disabled={isSubmitting}
            onClick={() => void loginWithPasskey()}
            className="min-h-[2.75rem] w-full"
          >
            Sign in with a passkey
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * The second step of a password sign-in. No session cookie exists yet: the
 * challenge token in the provider is the only thing holding the attempt open.
 */
function ChallengeFormView() {
  const {
    challenge,
    verifyMfa,
    verifyMfaPasskey,
    cancelChallenge,
    error,
    isSubmitting,
  } = useAuth();
  const form = useForm<MFAForm>({
    resolver: zodResolver(mfaSchema),
    defaultValues: { code: "" },
  });
  const submit = form.handleSubmit(async (values) => {
    await verifyMfa(values.code);
  });
  const canUsePasskey =
    Boolean(challenge?.methods.includes("passkey")) && passkeysSupported();
  const canUseCode = Boolean(
    challenge?.methods.includes("totp") ||
    challenge?.methods.includes("recovery_code"),
  );
  return (
    <div aria-labelledby="mfa-title">
      <AuthHeader
        id="mfa-title"
        title="Two-step verification"
        body={
          canUseCode
            ? "Enter the six-digit code from your authenticator app, or one of your recovery codes."
            : "Confirm your passkey to finish signing in."
        }
      />
      {error && <AuthError message={error.message} />}
      {canUseCode && (
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          className="grid gap-[1.05rem]"
        >
          <FormField
            id="code"
            label="Verification code"
            autoComplete="one-time-code"
            inputMode="text"
            autoFocus
            error={form.formState.errors.code?.message}
            {...form.register("code")}
          />
          <Button
            type="submit"
            disabled={isSubmitting}
            className="mt-[0.35rem] min-h-[2.75rem] w-full"
          >
            {isSubmitting ? "Verifying…" : "Verify"}
          </Button>
        </form>
      )}
      {canUsePasskey && (
        <>
          {canUseCode && <AuthDivider>or</AuthDivider>}
          <Button
            variant="outline"
            type="button"
            disabled={isSubmitting}
            onClick={() => void verifyMfaPasskey()}
            className="min-h-[2.75rem] w-full"
          >
            Use a passkey
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        type="button"
        onClick={cancelChallenge}
        className="mt-3 min-h-[2.4rem] w-full"
      >
        Back to sign in
      </Button>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex min-h-svh items-center justify-center gap-3 bg-[#f3f4f5]">
      <Brand compact />
      <Spinner aria-label="Loading" />
    </div>
  );
}
