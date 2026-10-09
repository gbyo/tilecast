import { isPlayerUrl, originPattern } from "@tilecast/companion-protocol";

/**
 * Action popup: the setup UX. The user opens the Browser Player, invokes
 * the extension, and the popup offers to connect exactly the visible
 * player origin — never every site, never by default. On approval the
 * worker persists the origin grant and registers the isolated bridge
 * for /player/* on that origin only.
 */

const BRIDGE_SCRIPT_ID = "tilecast-companion-bridge";

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
  const stored = await chrome.storage.local.get(["grantedOrigins"]);
  const origins = Array.isArray(stored["grantedOrigins"])
    ? (stored["grantedOrigins"] as unknown[])
    : [];
  return origins.includes(origin);
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
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [BRIDGE_SCRIPT_ID],
    });
  } catch {
    // Absent registration: nothing to clear.
  }
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: BRIDGE_SCRIPT_ID,
        matches: [`${origin}/player/*`],
        js: ["content.js"],
        runAt: "document_start",
        world: "ISOLATED",
        allFrames: false,
      },
    ]);
  } catch {
    await chrome.permissions.remove({ origins: [pattern] });
    return "failed";
  }
  const stored = await chrome.storage.local.get(["grantedOrigins"]);
  const origins = (
    Array.isArray(stored["grantedOrigins"])
      ? (stored["grantedOrigins"] as unknown[])
      : []
  ).filter((entry): entry is string => typeof entry === "string");
  if (!origins.includes(origin)) {
    origins.push(origin);
    await chrome.storage.local.set({ grantedOrigins: origins });
  }
  return "connected";
}

async function disconnect(origin: string): Promise<void> {
  const pattern = originPattern(origin);
  const stored = await chrome.storage.local.get([
    "grantedOrigins",
    "connections",
  ]);
  const origins = (
    Array.isArray(stored["grantedOrigins"])
      ? (stored["grantedOrigins"] as unknown[])
      : []
  ).filter((entry): entry is string => typeof entry === "string");
  const connections = (
    Array.isArray(stored["connections"]) ? stored["connections"] : []
  ) as { origin?: string }[];
  await chrome.storage.local.set({
    grantedOrigins: origins.filter((entry) => entry !== origin),
    connections: connections.filter((entry) => entry.origin !== origin),
  });
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [BRIDGE_SCRIPT_ID],
    });
  } catch {
    // Already gone.
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
