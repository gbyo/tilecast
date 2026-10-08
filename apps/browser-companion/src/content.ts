import {
  COMPANION_PLAYER_PATH,
  COMPANION_PROTOCOL,
  COMPANION_SOURCE,
  parseCompanionMessage,
  type CompanionMessage,
} from "@tilecast/companion-protocol";

/**
 * Isolated content bridge. Runs only on a granted Tilecast origin under
 * /player/* (the worker registers it after the user's explicit grant),
 * and only in the top frame. It relays validated page messages to the
 * service worker over chrome.runtime messaging and posts validated
 * answers back. It holds no privilege of its own: the worker
 * revalidates everything, and the bridge never touches chrome.tabs,
 * fetch, or script execution.
 */

const connectionId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

function eligible(): boolean {
  return (
    window === window.top &&
    window.location.pathname.startsWith(COMPANION_PLAYER_PATH)
  );
}

function post(message: CompanionMessage): void {
  window.postMessage(message, window.location.origin);
}

if (eligible()) {
  const connection = connectionId();
  let handshook = false;

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const parsed = parseCompanionMessage(event.data);
    if (!parsed || parsed.connectionId !== connection) return;
    if (parsed.kind === "companion-handshake") {
      if (handshook) return;
      handshook = true;
    } else if (!handshook) {
      return;
    } else if (
      parsed.kind !== "companion-describe" &&
      parsed.kind !== "companion-invoke" &&
      parsed.kind !== "companion-bye"
    ) {
      return;
    }
    void (async () => {
      let answer: unknown;
      try {
        answer = await chrome.runtime.sendMessage({
          connectionId: connection,
          message: parsed,
        });
      } catch {
        return;
      }
      const relayed = (answer as { message?: unknown } | null)?.message;
      const validated = parseCompanionMessage(relayed);
      if (!validated || validated.connectionId !== connection) return;
      if (
        validated.kind !== "companion-described" &&
        validated.kind !== "companion-result"
      ) {
        return;
      }
      post(validated);
    })();
  });

  post({
    source: COMPANION_SOURCE,
    kind: "companion-hello",
    protocol: COMPANION_PROTOCOL,
    connectionId: connection,
  });
}
