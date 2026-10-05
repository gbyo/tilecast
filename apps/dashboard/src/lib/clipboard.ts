import { toast } from "../components/ui/toast";

/** Copy in the browser or Studio shell; callers supply localized feedback. */
export async function copyText(
  value: string,
  feedback: { success: string; failure: string },
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    toast.add({ title: feedback.failure, type: "error" });
    return false;
  }
  toast.add({ title: feedback.success, type: "success" });
  return true;
}
