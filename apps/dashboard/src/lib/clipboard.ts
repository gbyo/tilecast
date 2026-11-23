import { toast } from "../components/ui/toast";

/**
 * Copy text in secure contexts with the Clipboard API, and fall back to the
 * legacy synchronous copy command for Tilecast's supported plain-HTTP LAN
 * origins. The fallback must run while the caller's user gesture is active.
 */
export async function writeTextToClipboard(value: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // Some browsers expose Clipboard but deny it on insecure origins.
    }
  }

  if (typeof document === "undefined" || !document.execCommand) return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/** Copy in the browser or Studio shell; callers supply localized feedback. */
export async function copyText(
  value: string,
  feedback: { success: string; failure: string },
): Promise<boolean> {
  const copied = await writeTextToClipboard(value);
  toast.add({
    title: copied ? feedback.success : feedback.failure,
    type: copied ? "success" : "error",
  });
  return copied;
}
