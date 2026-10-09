import {
  COMPANION_PROTOCOL,
  COMPANION_SOURCE,
  MAX_INPUT_BYTES,
  isPlayerUrl,
  parseCompanionMessage,
  type CompanionCapabilities,
} from "@tilecast/companion-protocol";
import { shippedProviders, type CompanionProvider } from "./providers";

/**
 * MV3 service worker. Ephemeral by design: connection and origin
 * configuration persist in extension storage, listeners register
 * synchronously at module load, and every wake rebuilds its state from
 * storage before answering. The worker revalidates everything the
 * content bridge relays: granted origin, /player/* path, live
 * connection, message shape, operation membership, and payload bounds.
 * There is deliberately no generic chrome.*, tabs, fetch, or script
 * RPC here — only describe and capability-scoped invoke.
 */

const STORE_ORIGINS = "grantedOrigins";
const STORE_CONNECTIONS = "connections";

interface StoredConnection {
  connectionId: string;
  origin: string;
  tabId: number;
  connectedAt: number;
}

export interface WorkerState {
  origins: string[];
  connections: StoredConnection[];
  providers: CompanionProvider[];
}

export async function loadState(): Promise<WorkerState> {
  const stored = await chrome.storage.local.get([
    STORE_ORIGINS,
    STORE_CONNECTIONS,
  ]);
  const origins = Array.isArray(stored[STORE_ORIGINS])
    ? (stored[STORE_ORIGINS] as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const connections = Array.isArray(stored[STORE_CONNECTIONS])
    ? (stored[STORE_CONNECTIONS] as StoredConnection[]).filter(
        (entry) =>
          typeof entry?.connectionId === "string" &&
          typeof entry?.origin === "string" &&
          typeof entry?.tabId === "number",
      )
    : [];
  return { origins, connections, providers: shippedProviders() };
}

async function saveConnections(connections: StoredConnection[]): Promise<void> {
  await chrome.storage.local.set({ [STORE_CONNECTIONS]: connections });
}

/** Grants one exact origin after the user approves the Chrome prompt. */
export async function grantOrigin(origin: string): Promise<string[]> {
  const state = await loadState();
  if (!state.origins.includes(origin)) {
    state.origins.push(origin);
    await chrome.storage.local.set({ [STORE_ORIGINS]: state.origins });
  }
  return state.origins;
}

export async function revokeOrigin(origin: string): Promise<void> {
  const state = await loadState();
  await chrome.storage.local.set({
    [STORE_ORIGINS]: state.origins.filter((entry) => entry !== origin),
    [STORE_CONNECTIONS]: state.connections.filter(
      (entry) => entry.origin !== origin,
    ),
  });
}

function providerCapabilities(
  providers: CompanionProvider[],
): CompanionCapabilities {
  const merged: CompanionCapabilities = {};
  for (const provider of providers) {
    let reported: CompanionCapabilities;
    try {
      reported = provider.describe();
    } catch {
      continue;
    }
    if (!reported || typeof reported !== "object") continue;
    for (const [id, report] of Object.entries(reported)) {
      if (merged[id] !== undefined) continue;
      if (
        typeof report?.version !== "number" ||
        !Number.isInteger(report.version) ||
        typeof report?.provider !== "string"
      ) {
        continue;
      }
      merged[id] = { version: report.version, provider: report.provider };
    }
  }
  return merged;
}

export interface BridgeRequest {
  connectionId: string;
  message: unknown;
}

export interface BridgeAnswer {
  message: unknown;
}

/**
 * Handles one content-bridge relay. Pure over the loaded state except
 * for connection persistence and provider invocation. Answers undefined
 * for anything that fails validation; the bridge stays silent rather
 * than leaking worker internals to the page.
 */
export async function handleBridgeMessage(
  state: WorkerState,
  senderUrl: string | undefined,
  senderTabId: number | undefined,
  request: BridgeRequest,
): Promise<BridgeAnswer | undefined> {
  if (senderUrl === undefined || !isPlayerUrl(senderUrl)) return undefined;
  const origin = new URL(senderUrl).origin;
  if (!state.origins.includes(origin)) return undefined;
  const parsed = parseCompanionMessage(request.message);
  if (!parsed || parsed.connectionId !== request.connectionId) {
    return undefined;
  }
  const live = state.connections.find(
    (entry) =>
      entry.connectionId === request.connectionId && entry.origin === origin,
  );
  if (parsed.kind === "companion-handshake") {
    if (parsed.player !== "tilecast-browser-player") return undefined;
    if (senderTabId === undefined) return undefined;
    const connections = state.connections.filter(
      (entry) => entry.connectionId !== request.connectionId,
    );
    connections.push({
      connectionId: request.connectionId,
      origin,
      tabId: senderTabId,
      connectedAt: Date.now(),
    });
    await saveConnections(connections);
    state.connections = connections;
    return {
      message: {
        source: COMPANION_SOURCE,
        kind: "companion-described",
        protocol: COMPANION_PROTOCOL,
        connectionId: request.connectionId,
        id: "handshake",
        capabilities: providerCapabilities(state.providers),
      },
    };
  }
  if (!live) return undefined;
  if (senderTabId !== undefined && senderTabId !== live.tabId) return undefined;
  switch (parsed.kind) {
    case "companion-describe":
      return {
        message: {
          source: COMPANION_SOURCE,
          kind: "companion-described",
          protocol: COMPANION_PROTOCOL,
          connectionId: request.connectionId,
          id: parsed.id,
          capabilities: providerCapabilities(state.providers),
        },
      };
    case "companion-invoke": {
      if (JSON.stringify(parsed.input).length > MAX_INPUT_BYTES) {
        return undefined;
      }
      const described = providerCapabilities(state.providers);
      // The operation names its capability: only a described capability
      // is invokable. The merged set gates membership; the owning
      // provider runs it.
      const owner = state.providers.find((provider) => {
        try {
          return provider.describe()[parsed.operation] !== undefined;
        } catch {
          return false;
        }
      });
      if (!owner || described[parsed.operation] === undefined) return undefined;
      try {
        const result = await owner.invoke(parsed.operation, parsed.input);
        if (
          !result ||
          typeof result.success !== "boolean" ||
          typeof result.code !== "string"
        ) {
          return undefined;
        }
        return {
          message: {
            source: COMPANION_SOURCE,
            kind: "companion-result",
            protocol: COMPANION_PROTOCOL,
            connectionId: request.connectionId,
            id: parsed.id,
            result: {
              success: result.success,
              code: result.code.slice(0, 80),
              ...(typeof result.message === "string" && result.message !== ""
                ? { message: result.message.slice(0, 240) }
                : {}),
            },
          },
        };
      } catch {
        return {
          message: {
            source: COMPANION_SOURCE,
            kind: "companion-result",
            protocol: COMPANION_PROTOCOL,
            connectionId: request.connectionId,
            id: parsed.id,
            result: {
              success: false,
              code: "provider_failed",
              message: "The provider failed.",
            },
          },
        };
      }
    }
    case "companion-bye": {
      const connections = state.connections.filter(
        (entry) => entry.connectionId !== request.connectionId,
      );
      await saveConnections(connections);
      state.connections = connections;
      return undefined;
    }
    default:
      return undefined;
  }
}

// Synchronous listener registration: the worker may wake for a message
// with no other module state alive.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    const state = await loadState();
    const answer = await handleBridgeMessage(
      state,
      sender.url,
      sender.tab?.id,
      message as BridgeRequest,
    );
    sendResponse(answer ?? null);
  })();
  return true;
});
