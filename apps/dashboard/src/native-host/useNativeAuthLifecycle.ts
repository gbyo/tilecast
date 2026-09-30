import { useEffect, useRef } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { useNativeHost } from "./NativeHostProvider";

/**
 * Keeps a native host's credential lifecycle in step with Studio's session.
 * The host holds its own OAuth credential for native API calls; it never
 * sees Studio's cookie or CSRF token, and these messages carry neither.
 *
 * - When Studio signs out, from any control, it reports auth/signed-out
 *   before it shows its sign-in page, so the host deletes its credential
 *   and does not start a new sign-in by itself.
 * - When the host asks for auth/sign-out-request, Studio performs its
 *   normal logout with its own CSRF token.
 *
 * Inert in a browser and with a host that does not offer authLifecycle.
 */
export function useNativeAuthLifecycle() {
  const host = useNativeHost();
  const auth = useAuth();
  const enabled = host.status === "ready" && host.capabilities.authLifecycle;
  const current = useRef({ host, auth });
  current.current = { host, auth };
  const { addSignOutHook } = auth;

  useEffect(() => {
    if (!enabled) return;
    return addSignOutHook(async () => {
      await current.current.host.send("auth/signed-out", {});
    });
  }, [enabled, addSignOutHook]);

  useEffect(() => {
    if (!enabled) return;
    return host.subscribe("auth/sign-out-request", () => {
      const { auth, host } = current.current;
      if (auth.status?.authenticated) {
        // The sign-out hook reports auth/signed-out when logout succeeds.
        void auth.logout();
      } else {
        void host.send("auth/signed-out", {});
      }
      return true;
    });
  }, [enabled, host]);
}

/** Mounts the lifecycle inside the native host and auth providers. */
export function NativeAuthLifecycle() {
  useNativeAuthLifecycle();
  return null;
}
