import { useCallback } from "react";
import { useNativeHost } from "./NativeHostProvider";
import {
  validateSystemShare,
  type HapticFeedback,
  type SystemSharePayload,
} from "./protocol";

/**
 * Returns a function that asks a native host for standard system feedback.
 * Studio decides when a state change deserves it and names only the meaning;
 * the host decides how that maps onto hardware. It does nothing in a browser
 * and in a host that did not negotiate systemHaptics, so callers never
 * check first.
 */
export function useNativeHaptic() {
  const host = useNativeHost();
  const enabled = host.status === "ready" && host.capabilities.systemHaptics;
  return useCallback(
    (feedback: HapticFeedback) => {
      if (enabled) void host.send("system/haptic", { feedback });
    },
    [enabled, host],
  );
}

/**
 * True when a native host negotiated the system share sheet. It answers
 * synchronously, so a caller can choose between the native sheet and a
 * browser path, such as navigator.share or a copy button, while it still
 * has the click.
 */
export function useNativeShareAvailable() {
  const host = useNativeHost();
  return host.status === "ready" && host.capabilities.systemShare;
}

/**
 * Returns a function that asks a native host to present the system share
 * sheet. It resolves true only when the host accepted, and false when the
 * request is unsafe to send, when there is no host, or when the host could
 * not present it. The caller then keeps its ordinary web behavior. Share
 * only content a person may see and pass on: never a link that holds a
 * session, an OAuth credential, a CSRF token, or any secret in its address.
 */
export function useNativeShare() {
  const host = useNativeHost();
  const enabled = host.status === "ready" && host.capabilities.systemShare;
  return useCallback(
    async (content: SystemSharePayload) => {
      const payload = validateSystemShare(content);
      if (!enabled || !payload) return false;
      const reply = await host.send("system/share", payload);
      return reply?.ok === true;
    },
    [enabled, host],
  );
}
