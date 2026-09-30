import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNativeHost } from "./NativeHostProvider";
import type { MediaIntakeCompletedPayload, MediaIntakeKind } from "./protocol";

/** A fresh opaque request id. It correlates one intake with its result. */
export function newMediaIntakeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `mi-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Whether the host negotiated media intake. It is true only for the main
 * page of a host that offers the capability.
 */
export function useNativeMediaIntakeSupported() {
  const host = useNativeHost();
  return (
    host.status === "ready" &&
    host.context === "main" &&
    host.capabilities.nativeMediaIntake
  );
}

/**
 * Refetches Studio's media queries when native intake finishes, wherever
 * the request began. The host uploaded the files itself, so Studio learns
 * only a small result: it never receives the assets. Mount it one time.
 * Inert in a browser.
 */
export function useNativeMediaIntakeRefresh() {
  const host = useNativeHost();
  const queryClient = useQueryClient();
  const supported = useNativeMediaIntakeSupported();
  useEffect(() => {
    if (!supported) return;
    return host.subscribe(
      "system/media-intake-completed",
      ({ uploadedCount }) => {
        if (uploadedCount > 0) {
          void queryClient.invalidateQueries({ queryKey: ["assets"] });
        }
        return true;
      },
    );
  }, [host, queryClient, supported]);
}

/**
 * Lets a native host choose media with the system pickers and upload it
 * with its own credential. The browser uploader stays the permanent path:
 *
 *   if (intake.available) intake.request()   // native pickers
 *   else input.click()                        // the web file input
 *
 * `available` answers synchronously and comes from the host's own status,
 * so a click that must open the web file input still has its user gesture.
 * request() resolves false when the host could not begin, and the caller
 * uses the browser path.
 */
export function useNativeMediaIntake(
  onCompleted?: (result: MediaIntakeCompletedPayload) => void,
) {
  const host = useNativeHost();
  const supported = useNativeMediaIntakeSupported();
  const [available, setAvailable] = useState(false);
  const pending = useRef<string | null>(null);
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  useEffect(() => {
    if (!supported) {
      setAvailable(false);
      return;
    }
    let current = true;
    void host.send("system/media-intake-status", {}).then((reply) => {
      if (current)
        setAvailable(reply?.ok === true && reply.payload.available === true);
    });
    return () => {
      current = false;
    };
  }, [host, supported]);

  useEffect(() => {
    if (!supported) return;
    return host.subscribe("system/media-intake-completed", (result) => {
      if (pending.current !== result.requestId) return false;
      pending.current = null;
      onCompletedRef.current?.(result);
      return true;
    });
  }, [host, supported]);

  const request = useCallback(
    async (
      options: { accept?: MediaIntakeKind[]; multiple?: boolean } = {},
    ) => {
      if (!available) return false;
      const requestId = newMediaIntakeId();
      pending.current = requestId;
      const reply = await host.send("system/media-intake", {
        requestId,
        ...options,
      });
      if (reply?.ok === true) return true;
      pending.current = null;
      // The host could not begin, for example because it lost its
      // credential. Studio uses its own uploader from now on.
      setAvailable(false);
      return false;
    },
    [available, host],
  );

  return { available, request };
}
