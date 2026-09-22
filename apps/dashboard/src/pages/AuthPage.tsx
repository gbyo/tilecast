import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@react-spectrum/s2/Button";
import { Content } from "@react-spectrum/s2/Content";
import { Heading } from "@react-spectrum/s2/Heading";
import { Divider } from "@react-spectrum/s2/Divider";
import { Form } from "@react-spectrum/s2/Form";
import { InlineAlert } from "@react-spectrum/s2/InlineAlert";
import { ProgressCircle } from "@react-spectrum/s2/ProgressCircle";
import { TextField } from "@react-spectrum/s2/TextField";
import { Text } from "@react-spectrum/s2/Text";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
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

const pageStyles = style({
  position: "relative",
  display: "grid",
  minHeight: "100vh",
  placeItems: "center",
  padding: { default: 16, md: 32 },
  backgroundColor: "gray-100",
});

const backdropStyles = style({
  position: "fixed",
  inset: 0,
  zIndex: 0,
  backgroundColor: "gray-900",
  backgroundPosition: "center",
  backgroundSize: "cover",
});

const contentStyles = style({
  position: "relative",
  zIndex: 1,
  display: "grid",
  width: "full",
  gap: 24,
});

const panelStyles = style({
  display: "grid",
  gap: 24,
  width: "full",
  maxWidth: 460,
  marginX: "auto",
  padding: { default: 24, md: 32 },
  backgroundColor: "base",
  borderRadius: "lg",
  borderWidth: 1,
  borderColor: "gray-200",
});

const widePanelStyles = style({ maxWidth: 720 });

const formViewStyles = style({ display: "grid", gap: 24 });

const headerStyles = style({
  display: "grid",
  gap: 8,
  textAlign: "center",
});

const passwordFieldsStyles = style({
  display: "grid",
  gridTemplateColumns: { default: ["1fr"], md: ["1fr", "1fr"] },
  gap: 20,
});

const buttonStyles = style({ width: "full" });

const logoStyles = style({ display: "flex", justifyContent: "center" });

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
    <main className={pageStyles}>
      <div
        className={backdropStyles}
        aria-hidden="true"
        style={{
          backgroundImage:
            'linear-gradient(rgb(18 27 38 / 44%), rgb(18 27 38 / 44%)), url("/api/v1/auth/background")',
        }}
      />
      <div className={contentStyles}>
        <div className={logoStyles}>
          <Brand compact />
        </div>
        <section
          className={mode === "setup" ? widePanelStyles : panelStyles}
          aria-label={mode === "setup" ? "Set up Tilecast" : "Sign in"}
        >
          {mode === "setup" ? (
            <SetupFormView />
          ) : auth.challenge ? (
            <ChallengeFormView />
          ) : (
            <LoginFormView />
          )}
        </section>
      </div>
    </main>
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
    <div className={formViewStyles}>
      <header className={headerStyles}>
        <Heading id="setup-title" level={1}>
          Set up Tilecast
        </Heading>
        <Text>Create the first owner account for this installation.</Text>
      </header>
      {error && (
        <InlineAlert variant="negative" fillStyle="subtleFill">
          <Heading level={2}>Setup could not be completed</Heading>
          <Content>{error.message}</Content>
        </InlineAlert>
      )}
      <Form
        onSubmit={(event) => void submit(event)}
        validationBehavior="aria"
      >
        <Controller
          control={form.control}
          name="organizationName"
          render={({ field, fieldState }) => (
            <TextField
              label="Organization name"
              autoComplete="organization"
              autoFocus
              isRequired
              isInvalid={fieldState.invalid}
              errorMessage={fieldState.error?.message}
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={(ref) => field.ref(ref?.getInputElement() ?? null)}
            />
          )}
        />
        <Controller
          control={form.control}
          name="ownerName"
          render={({ field, fieldState }) => (
            <TextField
              label="Your name"
              autoComplete="name"
              isRequired
              isInvalid={fieldState.invalid}
              errorMessage={fieldState.error?.message}
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={(ref) => field.ref(ref?.getInputElement() ?? null)}
            />
          )}
        />
        <Controller
          control={form.control}
          name="username"
          render={({ field, fieldState }) => (
            <TextField
              label="Email or username"
              autoComplete="username"
              isRequired
              isInvalid={fieldState.invalid}
              errorMessage={fieldState.error?.message}
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={(ref) => field.ref(ref?.getInputElement() ?? null)}
            />
          )}
        />
        <div className={passwordFieldsStyles}>
          <Controller
            control={form.control}
            name="password"
            render={({ field, fieldState }) => (
              <TextField
                label="Password"
                type="password"
                autoComplete="new-password"
                description="At least 12 characters"
                isRequired
                isInvalid={fieldState.invalid}
                errorMessage={fieldState.error?.message}
                name={field.name}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                ref={(ref) => field.ref(ref?.getInputElement() ?? null)}
              />
            )}
          />
          <Controller
            control={form.control}
            name="confirmPassword"
            render={({ field, fieldState }) => (
              <TextField
                label="Confirm password"
                type="password"
                autoComplete="new-password"
                isRequired
                isInvalid={fieldState.invalid}
                errorMessage={fieldState.error?.message}
                name={field.name}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                ref={(ref) => field.ref(ref?.getInputElement() ?? null)}
              />
            )}
          />
        </div>
        <Button
          styles={buttonStyles}
          type="submit"
          variant="accent"
          isDisabled={isSubmitting}
          isPending={isSubmitting}
        >
          {isSubmitting ? "Creating installation…" : "Create installation"}
        </Button>
      </Form>
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

  useEffect(() => {
    if (!autofillReady) return;
    return watchForPasskeyAutofill();
    // watchForPasskeyAutofill is recreated on every render; re-arming the
    // ceremony on each one would abort the pending request the user is about
    // to answer, so this intentionally depends only on availability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofillReady]);

  const passkeys = Boolean(status?.passkeysAvailable) && passkeysSupported();
  return (
    <div className={formViewStyles}>
      <header className={headerStyles}>
        <Heading id="login-title" level={1}>
          Sign in
        </Heading>
        <Text>Manage your Tilecast displays.</Text>
      </header>
      {error && (
        <InlineAlert variant="negative" fillStyle="subtleFill">
          <Heading level={2}>Sign-in failed</Heading>
          <Content>{error.message}</Content>
        </InlineAlert>
      )}
      <Form
        onSubmit={(event) => void submit(event)}
        validationBehavior="aria"
      >
        <Controller
          control={form.control}
          name="username"
          render={({ field, fieldState }) => (
            <TextField
              label="Email or username"
              autoComplete="username webauthn"
              autoFocus
              isRequired
              isInvalid={fieldState.invalid}
              errorMessage={fieldState.error?.message}
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={(ref) => field.ref(ref?.getInputElement() ?? null)}
            />
          )}
        />
        <Controller
          control={form.control}
          name="password"
          render={({ field, fieldState }) => (
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              isRequired
              isInvalid={fieldState.invalid}
              errorMessage={fieldState.error?.message}
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={(ref) => field.ref(ref?.getInputElement() ?? null)}
            />
          )}
        />
        <Button
          styles={buttonStyles}
          type="submit"
          variant="accent"
          isDisabled={isSubmitting}
          isPending={isSubmitting}
        >
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
      </Form>
      {passkeys && (
        <>
          <Divider />
          <Button
            styles={buttonStyles}
            isDisabled={isSubmitting}
            onPress={() => void loginWithPasskey()}
          >
            Sign in with a passkey
          </Button>
        </>
      )}
    </div>
  );
}

/** The second step of a password sign-in. A session cookie does not exist yet. */
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
    <div className={formViewStyles}>
      <header className={headerStyles}>
        <Heading id="mfa-title" level={1}>
          Two-step verification
        </Heading>
        <Text>
          {canUseCode
            ? "Enter the six-digit code from your authenticator app, or one of your recovery codes."
            : "Confirm your passkey to finish signing in."}
        </Text>
      </header>
      {error && (
        <InlineAlert variant="negative" fillStyle="subtleFill">
          <Heading level={2}>Verification failed</Heading>
          <Content>{error.message}</Content>
        </InlineAlert>
      )}
      {canUseCode && (
        <Form
          onSubmit={(event) => void submit(event)}
          validationBehavior="aria"
        >
          <Controller
            control={form.control}
            name="code"
            render={({ field, fieldState }) => (
              <TextField
                label="Verification code"
                autoComplete="one-time-code"
                inputMode="text"
                autoFocus
                isRequired
                isInvalid={fieldState.invalid}
                errorMessage={fieldState.error?.message}
                name={field.name}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                ref={(ref) => field.ref(ref?.getInputElement() ?? null)}
              />
            )}
          />
          <Button
            styles={buttonStyles}
            type="submit"
            variant="accent"
            isDisabled={isSubmitting}
            isPending={isSubmitting}
          >
            {isSubmitting ? "Verifying…" : "Verify"}
          </Button>
        </Form>
      )}
      {canUsePasskey && (
        <>
          {canUseCode && <Divider />}
          <Button
            styles={buttonStyles}
            isDisabled={isSubmitting}
            onPress={() => void verifyMfaPasskey()}
          >
            Use a passkey
          </Button>
        </>
      )}
      <Button
        styles={buttonStyles}
        variant="secondary"
        isDisabled={isSubmitting}
        onPress={cancelChallenge}
      >
        Back to sign in
      </Button>
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className={pageStyles}>
      <div className={contentStyles}>
        <div className={logoStyles}>
          <Brand compact />
        </div>
        <section className={panelStyles} aria-live="polite">
          <Heading level={1}>Loading Tilecast</Heading>
          <ProgressCircle
            aria-label="Loading"
            isIndeterminate
            size="M"
          />
        </section>
      </div>
    </main>
  );
}
