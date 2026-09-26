import { createContext, useContext, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { canManage } from "../plugins/shared";

/** What a plugin page knows about the signed-in user. */
export interface StudioSession {
  csrfToken: string;
  role?: string;
  /** Owner or Administrator: may change plugin configuration. */
  canManage: boolean;
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
