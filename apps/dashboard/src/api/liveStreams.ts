/**
 * Ephemeral live-stream teardown only. Ending a live MJPEG session during
 * dialog close or page unload must survive navigation, so this DELETE
 * carries `keepalive: true` on a hand-built RequestInit. The typed
 * transport (openapi-fetch) does not forward `keepalive` — verified by
 * LiveStreamDialog.test.tsx, which pins the exact fetch init — so this
 * one call stays on raw fetch. Session start and renewal are ordinary
 * JSON and live on the typed transport (see ./domains/screens.ts), and
 * the MJPEG relay URL is not a fetch call at all
 * (`screenLiveStreamUrl` in ./domains/screens.ts).
 */
export async function endLiveStreamSession(
  screenId: string,
  sessionId: string,
  csrfToken: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/screens/${screenId}/live-stream/${sessionId}`,
    {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": csrfToken },
      keepalive: true,
    },
  );
  if (!response.ok) throw new Error("Unable to end the live stream session.");
}
