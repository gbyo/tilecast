import { isPlayerUrl, originPattern } from "@tilecast/companion-protocol";
import { syncBridgeRegistration } from "./bridge-registration";

/**
 * Action popup: the setup UX. The user opens the Browser Player, invokes
 * the extension, and the popup offers to connect exactly the visible
 * player origin — never every site, never by default. On approval the
 * worker persists the origin grant and registers the isolated bridge
 * for /player/* on the granted origins only.
 */

async function grantedOrigins(): Promise<string[]> {
  const stored = await chrome.storage.local.get(["grantedOrigins"]);
  return (
    Array.isArray(stored["grantedOrigins"])
      ? (stored["grantedOrigins"] as unknown[])
      : []
  ).filter((entry): entry is string => typeof entry === "string");
}

async function currentPlayerTab(): Promise<
  { id: number; url: string } | undefined
> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined || tab.url === undefined) return undefined;
  if (!isPlayerUrl(tab.url)) return undefined;
  return { id: tab.id, url: tab.url };
}

async function isConnected(origin: string): Promise<boolean> {
  return (await grantedOrigins()).includes(origin);
}

async function connect(
  url: string,
): Promise<"connected" | "declined" | "failed"> {
  const pattern = originPattern(url);
  if (!pattern) return "failed";
  const origin = new URL(url).origin;
  let granted: boolean;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return "failed";
  }
  if (!granted) return "declined";
  const origins = await grantedOrigins();
  const next = origins.includes(origin) ? origins : [...origins, origin];
  try {
    await syncBridgeRegistration(chrome.scripting, next);
  } catch {
    // Restore the bridge for the origins that were already granted.
    try {
      await syncBridgeRegistration(chrome.scripting, origins);
    } catch {
      // Nothing more to restore from here.
    }
    await chrome.permissions.remove({ origins: [pattern] });
    return "failed";
  }
  if (next !== origins)
    await chrome.storage.local.set({ grantedOrigins: next });
  return "connected";
}

async function disconnect(origin: string): Promise<void> {
  const pattern = originPattern(origin);
  const stored = await chrome.storage.local.get(["connections"]);
  const remaining = (await grantedOrigins()).filter(
    (entry) => entry !== origin,
  );
  const connections = (
    Array.isArray(stored["connections"]) ? stored["connections"] : []
  ) as { origin?: string }[];
  await chrome.storage.local.set({
    grantedOrigins: remaining,
    connections: connections.filter((entry) => entry.origin !== origin),
  });
  try {
    // The other granted origins keep their bridge.
    await syncBridgeRegistration(chrome.scripting, remaining);
  } catch {
    // The worker grant is already gone, so a stale match stays inert.
  }
  if (pattern) {
    try {
      await chrome.permissions.remove({ origins: [pattern] });
    } catch {
      // Chrome keeps the prompt state; the worker grant is already gone.
    }
  }
}

function render(status: string, action: string | null): void {
  document.getElementById("status")!.textContent = status;
  const button = document.getElementById("action") as HTMLButtonElement;
  if (action === null) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.textContent = action;
}

document.addEventListener("DOMContentLoaded", () => {
  void (async () => {
    const tab = await currentPlayerTab();
    if (!tab) {
      render(
        "Open a Tilecast Browser Player page, then open this popup again.",
        null,
      );
      return;
    }
    const origin = new URL(tab.url).origin;
    if (await isConnected(origin)) {
      render(`Connected to ${origin}.`, "Disconnect");
      (document.getElementById("action") as HTMLButtonElement).onclick =
        async () => {
          await disconnect(origin);
          render(`Disconnected from ${origin}.`, null);
        };
      return;
    }
    render(`This player runs at ${origin}.`, "Connect this player");
    (document.getElementById("action") as HTMLButtonElement).onclick =
      async () => {
        const outcome = await connect(tab.url);
        if (outcome === "connected") {
          render(
            `Connected to ${origin}. Reload the player page to finish.`,
            "Disconnect",
          );
          (document.getElementById("action") as HTMLButtonElement).onclick =
            async () => {
              await disconnect(origin);
              render(`Disconnected from ${origin}.`, null);
            };
        } else if (outcome === "declined") {
          render("The browser permission request was declined.", "Try again");
        } else {
          render("Connecting failed. Try again.", "Try again");
        }
      };
  })();
});
