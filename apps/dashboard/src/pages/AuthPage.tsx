import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { apiErrorMessage } from "../i18n";
import {
  makeLoginSchema,
  makeMfaSchema,
  type LoginForm,
  type MFAForm,
} from "../auth/schemas";
import { passkeysSupported } from "../auth/webauthn";
import { Brand } from "../components/Brand";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "../components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { SetupFlow } from "./SetupFlow";

export function AuthPage({ mode }: { mode: "setup" | "login" }) {
  const auth = useAuth();
  const { t } = useTranslation(["auth", "common"]);
  const navigate = useNavigate();
  const location = useLocation();
  const [backgroundFailed, setBackgroundFailed] = useState(false);
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
  // Keep the setup flow card, but let the original right-framed artwork fill
  // the sign-in screen without a dimming overlay or card backdrop.
  const isLogin = mode === "login";
  return (
    <main className={isLogin ? "auth-page--login relative isolate flex min-h-svh flex-col items-center justify-center overflow-hidden bg-[#080f25] p-6 text-white sm:p-10 md:items-start md:px-[clamp(3rem,9vw,10rem)]" : "relative isolate flex min-h-svh flex-col items-center justify-center gap-6 overflow-hidden bg-muted p-6 md:p-10"}>
      {!backgroundFailed && (
        <>
          <img
            src="/api/v1/auth/background"
            alt=""
            aria-hidden="true"
            className={`absolute inset-0 -z-20 size-full object-cover ${isLogin ? "object-[25%_center] md:object-center" : ""}`}
            onError={() => setBackgroundFailed(true)}
          />
          {!isLogin && <div className="absolute inset-0 -z-10 bg-black/40" />}
        </>
      )}
      <div
        className={`relative z-10 flex w-full flex-col gap-6 ${mode === "setup" ? "max-w-md" : "max-w-sm"}`}
      >
        <div className={isLogin ? "flex justify-start" : "flex justify-center"}>
          <div
            className={
              isLogin || backgroundFailed ? "" : "rounded-md bg-card/90 px-3 py-1.5"
            }
          >
            <Brand compact />
          </div>
        </div>
        <Card className={isLogin ? "gap-5 overflow-visible bg-transparent py-0 text-white ring-0 shadow-none" : ""}>
          {mode === "setup" ? (
            <CardContent className="pt-6">
              <SetupFlow />
            </CardContent>
          ) : auth.challenge ? (
            <>
              <CardHeader className={isLogin ? "px-0 text-left" : "text-center"}>
                <h1
                  data-slot="card-title"
                  className="font-heading text-xl font-medium"
                >
                  {t("challenge.title")}
                </h1>
                <CardDescription className={isLogin ? "text-slate-300" : ""}>
                  {auth.challenge.methods.includes("totp") ||
                  auth.challenge.methods.includes("recovery_code")
                    ? t("challenge.codeDescription")
                    : t("challenge.passkeyDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className={isLogin ? "px-0" : ""}>
                <ChallengeFormView />
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className={isLogin ? "px-0 text-left" : "text-center"}>
                <h1
                  data-slot="card-title"
                  className="font-heading text-xl font-medium"
                >
                  {t("login.title")}
                </h1>
                <CardDescription className={isLogin ? "text-slate-300" : ""}>{t("login.description")}</CardDescription>
              </CardHeader>
              <CardContent className={isLogin ? "px-0" : ""}>
                <LoginFormView />
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}

function AuthError({ message }: { message: string }) {
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
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
  const { t } = useTranslation(["auth", "common"]);
  // The schema is built at render time so its messages follow the interface
  // language.
  const schema = useMemo(() => makeLoginSchema(t), [t]);
  const form = useForm<LoginForm>({
    resolver: zodResolver(schema),
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
    <form onSubmit={(event) => void submit(event)} noValidate>
      <FieldGroup>
        {error && <AuthError message={apiErrorMessage(error)} />}
        <Field>
          <FieldLabel htmlFor="username">{t("fields.username")}</FieldLabel>
          <Input
            id="username"
            autoComplete="username webauthn"
            autoFocus
            aria-invalid={Boolean(form.formState.errors.username)}
            {...form.register("username")}
          />
          <FieldError errors={[form.formState.errors.username]} />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">{t("fields.password")}</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(form.formState.errors.password)}
            {...form.register("password")}
          />
          <FieldError errors={[form.formState.errors.password]} />
        </Field>
        <Field>
          <Button type="submit" disabled={isSubmitting} className="bg-white text-slate-950 hover:bg-slate-100">
            {isSubmitting ? t("login.submitting") : t("login.submit")}
          </Button>
        </Field>
        {passkeys && (
          <>
            <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
              {t("separators.or")}
            </FieldSeparator>
            <Field>
              <Button
                variant="outline"
                className="border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                type="button"
                disabled={isSubmitting}
                onClick={() => void loginWithPasskey()}
              >
                {t("login.passkeyButton")}
              </Button>
            </Field>
          </>
        )}
      </FieldGroup>
    </form>
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
  const { t } = useTranslation(["auth", "common"]);
  const schema = useMemo(() => makeMfaSchema(t), [t]);
  const form = useForm<MFAForm>({
    resolver: zodResolver(schema),
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
  // The challenge accepts both authenticator codes and recovery codes, which
  // have different shapes, so this stays a plain input rather than a
  // segmented one-time-code field.
  return (
    <div className="grid gap-4">
      {error && <AuthError message={apiErrorMessage(error)} />}
      {canUseCode && (
        <form onSubmit={(event) => void submit(event)} noValidate>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="code">{t("challenge.codeLabel")}</FieldLabel>
              <Input
                id="code"
                autoComplete="one-time-code"
                inputMode="text"
                autoFocus
                aria-invalid={Boolean(form.formState.errors.code)}
                {...form.register("code")}
              />
              <FieldError errors={[form.formState.errors.code]} />
            </Field>
            <Field>
              <Button type="submit" disabled={isSubmitting} className="bg-white text-slate-950 hover:bg-slate-100">
                {isSubmitting
                  ? t("challenge.submitting")
                  : t("challenge.submit")}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      )}
      {canUsePasskey && (
        <div className="grid gap-4">
          {canUseCode && (
            <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
              {t("separators.or")}
            </FieldSeparator>
          )}
          <Button
            variant="outline"
            className="border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            type="button"
            disabled={isSubmitting}
            onClick={() => void verifyMfaPasskey()}
          >
            {t("challenge.passkeyButton")}
          </Button>
        </div>
      )}
      <Button variant="ghost" type="button" onClick={cancelChallenge} className="text-white hover:bg-white/10 hover:text-white">
        {t("challenge.back")}
      </Button>
    </div>
  );
}

function LoadingScreen() {
  const { t } = useTranslation(["auth", "common"]);
  return (
    <div className="flex min-h-svh items-center justify-center gap-3 bg-muted">
      <Brand compact />
      <Spinner aria-label={t("status.loading")} />
    </div>
  );
}
