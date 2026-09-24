import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import type {
  AuthStatus,
  LoginInput,
  MFAChallenge,
  SessionResult,
  SetupInput,
} from "../api/types";
import {
  conditionalMediationAvailable,
  isPasskeyCancellation,
  serializeAssertion,
  signalUnknownCredential,
  toRequestOptions,
} from "./webauthn";

type AuthContextValue = {
  status?: AuthStatus;
  isLoading: boolean;
  error: Error | null;
  /** Set when a password was accepted but a second factor is still owed. */
  challenge?: MFAChallenge;
  setup: (input: SetupInput) => Promise<void>;
  login: (input: LoginInput) => Promise<void>;
  verifyMfa: (code: string) => Promise<void>;
  /** Completes a pending challenge with the account's passkey. */
  verifyMfaPasskey: () => Promise<void>;
  /** Signs in with a discoverable passkey, with no username or password. */
  loginWithPasskey: () => Promise<void>;
  /**
   * Arms autofill-assisted sign-in: passkeys appear in the browser's own
   * autofill list on the username field. Returns a cleanup function.
   */
  watchForPasskeyAutofill: () => () => void;
  cancelChallenge: () => void;
  logout: () => Promise<void>;
  isSubmitting: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const authKey = ["auth", "status"] as const;

/**
 * Every failure here is already surfaced through `error` on the context, so
 * the promise these helpers return resolves either way. Rejecting as well
 * would make each caller repeat the same catch to avoid an unhandled
 * rejection, and a wrong password is an expected outcome, not a fault.
 */
async function settle(work: Promise<unknown>) {
  await work.catch(() => undefined);
}

function isChallenge(
  result: MFAChallenge | SessionResult,
): result is MFAChallenge {
  return "mfaRequired" in result && result.mfaRequired;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  // The provider builds the only user-visible errors in this file (an
  // expired challenge, a missing passkey) at call time, so they translate
  // here; everything the server says is rendered by the pages untouched.
  const { t } = useTranslation(["auth"]);
  const [challenge, setChallenge] = useState<MFAChallenge | undefined>();
  const passkeyAutofillController = useRef<AbortController | null>(null);
  const cancelPasskeyAutofill = () => {
    const controller = passkeyAutofillController.current;
    if (!controller) return;
    passkeyAutofillController.current = null;
    controller.abort();
  };
  const query = useQuery({
    queryKey: authKey,
    queryFn: api.authStatus,
    retry: false,
    staleTime: 30_000,
  });
  const setSession = (result: SessionResult) => {
    leaveChallenge();
    queryClient.setQueryData<AuthStatus>(authKey, {
      ...(query.data ?? { setupRequired: false }),
      setupRequired: false,
      authenticated: true,
      ...result,
    });
  };
  const setupMutation = useMutation({
    mutationFn: api.setup,
    onSuccess: setSession,
  });
  const loginMutation = useMutation({
    mutationFn: api.login,
    onSuccess: (result) => {
      if (isChallenge(result)) {
        // A fresh challenge must not inherit the error text from a previous
        // attempt at a different step.
        verifyMutation.reset();
        passkeyChallengeMutation.reset();
        setChallenge(result);
      } else setSession(result);
    },
  });
  const verifyMutation = useMutation({
    mutationFn: (code: string) => {
      if (!challenge) throw new Error(t("errors.challengeExpired"));
      return api.verifyMfa(challenge.challengeToken, code);
    },
    onSuccess: setSession,
  });
  // The passkey mutations own the whole ceremony: the browser call sits
  // between two requests, so it cannot be split across React state.
  const passkeyChallengeMutation = useMutation({
    mutationFn: async () => {
      cancelPasskeyAutofill();
      if (!challenge) throw new Error(t("errors.challengeExpired"));
      const ceremony = await api.mfaPasskeyOptions(challenge.challengeToken);
      const credential = (await navigator.credentials.get({
        publicKey: toRequestOptions(ceremony.options),
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error(t("errors.noPasskeyProvided"));
      return api.passkeyLogin(
        ceremony.challengeToken,
        serializeAssertion(credential),
      );
    },
    onSuccess: setSession,
  });
  // One discoverable ceremony, driven two ways: from a button (modal) or from
  // the browser's autofill list (conditional). A conditional request stays
  // pending for as long as the page is open, so it deliberately does not run
  // through a mutation — its "pending" is idle waiting, not work in progress,
  // and would otherwise disable the sign-in button forever.
  const runPasskeyCeremony = async (signal?: AbortSignal) => {
    const ceremony = await api.passkeyLoginOptions();
    const credential = (await navigator.credentials.get({
      publicKey: toRequestOptions(ceremony.options),
      ...(signal ? { mediation: "conditional" as const, signal } : {}),
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error(t("errors.noPasskeyProvided"));
    try {
      return await api.passkeyLogin(
        ceremony.challengeToken,
        serializeAssertion(credential),
      );
    } catch (error) {
      // A credential this server no longer holds should stop being offered,
      // rather than reappearing at every sign-in and failing again.
      if (error instanceof ApiError && error.code === "passkey_rejected") {
        const rpId = ceremony.options.rpId;
        if (typeof rpId === "string")
          void signalUnknownCredential(rpId, credential.id);
      }
      throw error;
    }
  };

  const passkeyLoginMutation = useMutation({
    mutationFn: () => {
      cancelPasskeyAutofill();
      return runPasskeyCeremony();
    },
    onSuccess: setSession,
  });

  const watchForPasskeyAutofill = () => {
    // Chromium allows only one WebAuthn ceremony at a time. Keep the pending
    // conditional request owned here so an explicit passkey action can cancel
    // it before opening its modal ceremony.
    cancelPasskeyAutofill();
    const controller = new AbortController();
    passkeyAutofillController.current = controller;
    void (async () => {
      if (!(await conditionalMediationAvailable())) return;
      if (controller.signal.aborted) return;
      try {
        setSession(await runPasskeyCeremony(controller.signal));
      } catch {
        // Abandoning or dismissing an autofill request is the normal outcome
        // and must never surface as a sign-in error.
      } finally {
        if (passkeyAutofillController.current === controller)
          passkeyAutofillController.current = null;
      }
    })();
    return () => {
      if (passkeyAutofillController.current === controller)
        passkeyAutofillController.current = null;
      controller.abort();
    };
  };
  /**
   * Every error here is rendered from mutation state, which outlives the view
   * that produced it. Leaving the challenge without clearing it puts "That
   * code is not correct" on the plain sign-in form before the user has typed
   * anything, so the step-scoped mutations are reset on every transition out.
   */
  function leaveChallenge() {
    setChallenge(undefined);
    verifyMutation.reset();
    passkeyChallengeMutation.reset();
    passkeyLoginMutation.reset();
  }

  const logoutMutation = useMutation({
    mutationFn: async () => api.logout(query.data?.csrfToken ?? ""),
    onSuccess: () => {
      leaveChallenge();
      queryClient.setQueryData<AuthStatus>(authKey, {
        ...(query.data ?? { setupRequired: false }),
        setupRequired: false,
        authenticated: false,
        user: undefined,
        csrfToken: undefined,
        mfaEnrollmentRequired: false,
      });
    },
  });

  const passkeyError =
    passkeyChallengeMutation.error ?? passkeyLoginMutation.error;
  const mutationError =
    setupMutation.error ??
    loginMutation.error ??
    verifyMutation.error ??
    // A dismissed system passkey prompt is a normal outcome, not a failure to
    // report back to the user.
    (isPasskeyCancellation(passkeyError) ? null : passkeyError) ??
    logoutMutation.error;
  return (
    <AuthContext.Provider
      value={{
        status: query.data,
        isLoading: query.isLoading,
        error: query.error ?? mutationError,
        challenge,
        setup: (input) => settle(setupMutation.mutateAsync(input)),
        login: (input) => settle(loginMutation.mutateAsync(input)),
        verifyMfa: (code) => settle(verifyMutation.mutateAsync(code)),
        verifyMfaPasskey: () => settle(passkeyChallengeMutation.mutateAsync()),
        loginWithPasskey: () => settle(passkeyLoginMutation.mutateAsync()),
        watchForPasskeyAutofill,
        cancelChallenge: leaveChallenge,
        logout: () => settle(logoutMutation.mutateAsync()),
        isSubmitting:
          setupMutation.isPending ||
          loginMutation.isPending ||
          verifyMutation.isPending ||
          passkeyChallengeMutation.isPending ||
          passkeyLoginMutation.isPending ||
          logoutMutation.isPending,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
