import { createContext, useContext, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { canManage } from "../plugins/shared";

/** What a plugin page knows about the signed-in user. */
export interface StudioSession {
  csrfToken: string;
  role?: string;
  /** Owner or Administrator: may change plugin configuration. */
  canManage: boolean;
  /**
   * Whether the session is authenticated. Top-level portal shells render
   * nothing and redirect to login while this is false.
   */
  authenticated: boolean;
  /** Whether the installation still needs owner setup (portals send it to /setup). */
  setupRequired: boolean;
  /** True while the session is resolving; shells render nothing until then. */
  isLoading: boolean;
  /** Whether a logout is in flight. */
  isSubmitting: boolean;
  /** Ends the session. */
  logout: () => Promise<void>;
}

const StudioSessionOverride = createContext<StudioSession | null>(null);

/**
 * The signed-in user as plugin pages see it. Plugins never read Studio's
 * auth state directly, so this is the whole contract; tests replace it with
 * `renderPluginRoute`.
 */
export function useStudioSession(): StudioSession {
  const override = useContext(StudioSessionOverride);
  // useAuth throws outside AuthProvider. Tests render plugin pages with a
  // session override instead, so a missing provider is not an error there.
  let auth: ReturnType<typeof useAuth> | null = null;
  try {
    // Called on every render; the try only observes a missing provider.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    auth = useAuth();
  } catch (error) {
    if (!override) throw error;
  }
  if (override) return override;
  if (!auth) throw new Error("useStudioSession must be used within Studio");
  const role = auth.status?.user?.role;
  return {
    csrfToken: auth.status?.csrfToken ?? "",
    role,
    canManage: canManage(role),
    authenticated: auth.status?.authenticated ?? false,
    setupRequired: auth.status?.setupRequired ?? false,
    isLoading: auth.isLoading,
    isSubmitting: auth.isSubmitting,
    logout: auth.logout,
  };
}

export function StudioSessionProvider({
  session,
  children,
}: {
  session: StudioSession;
  children: ReactNode;
}) {
  return (
    <StudioSessionOverride.Provider value={session}>
      {children}
    </StudioSessionOverride.Provider>
  );
}
