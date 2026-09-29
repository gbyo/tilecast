import { useCallback } from "react";
import { useNativeHost } from "@/native-host/NativeHostProvider";
import {
  isPresentationPath,
  PRESENTATION_ROOT,
  type PresentationSize,
} from "@/native-host/protocol";

export type NativePresentationRequest = {
  /** A route below /__native/modal. */
  path: string;
  /** Already localized. The native header shows it until the page updates it. */
  title: string;
  subtitle?: string;
  size?: PresentationSize;
  dismissible?: boolean;
};

/** A presentation route: the reserved root and URL-encoded segments. */
export function presentationPath(...segments: string[]) {
  return [PRESENTATION_ROOT, ...segments.map(encodeURIComponent)].join("/");
}

/**
 * A fresh opaque presentation id. getRandomValues, unlike randomUUID, also
 * works on a plain-HTTP local network installation.
 */
export function newPresentationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `p-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Returns a function that asks a native host to present a route in a native
 * sheet. It resolves true only when the host accepted; the caller then shows
 * nothing itself. Otherwise the caller shows its normal web dialog, which
 * stays the permanent browser path:
 *
 *   if (!(await openNativePresentation(request))) setDialogOpen(true);
 */
export function useOpenNativePresentation() {
  const host = useNativeHost();
  return useCallback(
    async (request: NativePresentationRequest) => {
      if (
        host.status !== "ready" ||
        host.context !== "main" ||
        !host.capabilities.nativePresentations ||
        !isPresentationPath(request.path)
      ) {
        return false;
      }
      const reply = await host.send("presentation/open", {
        presentationId: newPresentationId(),
        ...request,
      });
      return reply?.ok === true;
    },
    [host],
  );
}
