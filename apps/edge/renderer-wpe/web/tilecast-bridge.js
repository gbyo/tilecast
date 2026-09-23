/*
 * Tilecast WPE bridge: implements the `window.tilecast` interface the
 * trusted DOM runtime (apps/player-linux/src/renderer) already uses, on top
 * of two WebKit script message handlers owned by tilecast-renderer-wpe.
 *
 * Injected by the renderer host at document start, top frame only, and only
 * on tilecast://runtime/ pages. Remote content never sees it.
 *
 *   host → page: globalThis.__tilecastHost.receive(name, json)
 *   page → host: webkit.messageHandlers.tilecast.postMessage({type, ...})
 *                webkit.messageHandlers.tilecastRequest.postMessage({...})
 *
 * The page never names paths, commands or credentials. Evidence reports are
 * tagged with the activation the page is actually showing, so the daemon can
 * discard reports that belong to a replaced presentation.
 */
(() => {
  "use strict";

  const handlers = globalThis.webkit && globalThis.webkit.messageHandlers;
  if (!handlers || !handlers.tilecast) {
    return;
  }
  const post = (message) => handlers.tilecast.postMessage(message);

  const listeners = {
    present: [],
    plugins: [],
    syncPosition: [],
    identify: [],
    retry: [],
    skip: [],
  };
  let current = null; // { activationId, generation }
  let lastPresentation = null;
  let lastPlugins = null;
  let lastSyncPosition = null;

  const emit = (list, value) => {
    for (const callback of list) {
      try {
        callback(value);
      } catch (error) {
        console.error("tilecast bridge listener failed", error);
      }
    }
  };

  // The DOM runtime reports kebab-case kinds; the IPC contract uses the same
  // vocabulary in snake_case (edge_protocol::ipc::event::EvidenceKind).
  const EVIDENCE = new Set([
    "item-started",
    "item-transition",
    "video-progress",
    "image-shown",
    "widget-shown",
    "widget-empty",
    "widget-alive",
    "layout-shown",
    "layout-alive",
    "layout-zone-rendered",
    "website-loaded",
    "website-alive",
    "frame-changed",
  ]);

  const text = (value, max) => String(value == null ? "" : value).slice(0, max);

  const reportEvidence = (kind, itemId, zoneId) => {
    if (!current) return;
    const message = { type: "renderer.progress", activation: current, kind };
    if (itemId != null) message.itemId = text(itemId, 160);
    if (zoneId != null) message.zoneId = text(zoneId, 160);
    post(message);
  };

  const afterPaint = (callback) =>
    requestAnimationFrame(() => requestAnimationFrame(callback));

  const applyActivation = (data) => {
    const presentation = data.presentation;
    const sameActivation =
      current &&
      current.activationId === data.activationId &&
      current.generation === data.generation;
    current = { activationId: data.activationId, generation: data.generation };
    if (!sameActivation) {
      lastPresentation = presentation;
      emit(listeners.present, presentation);
    }
    post({ type: "presentation.accepted", activation: current });
    if (presentation.state !== "playing") {
      // Status surfaces produce no item evidence of their own.
      const shown = current;
      afterPaint(() => {
        if (current === shown) reportEvidence("surface_shown", null, null);
      });
    }
  };

  const host = {
    receive(name, json) {
      let data;
      try {
        data = JSON.parse(json);
      } catch {
        return false;
      }
      switch (name) {
        case "presentation.activate":
          try {
            applyActivation(data);
          } catch (error) {
            post({
              type: "presentation.rejected",
              activation: {
                activationId: data.activationId,
                generation: data.generation,
              },
              code: "runtime_error",
              message: text(error && error.message, 240),
            });
          }
          return true;
        case "plugin.state":
          lastPlugins = {
            plugins: data.plugins,
            clockOffsetMs: data.clockOffsetMs,
          };
          emit(listeners.plugins, lastPlugins);
          return true;
        case "presentation.clear":
          current = null;
          lastPresentation = { state: "sleep" };
          emit(listeners.present, lastPresentation);
          return true;
        case "presentation.identify":
          emit(listeners.identify, {
            name: data.name,
            durationSeconds: data.durationSeconds,
          });
          return true;
        case "renderer.command":
          if (data.command === "retry_item") emit(listeners.retry, undefined);
          if (data.command === "skip_item") emit(listeners.skip, undefined);
          return true;
        case "sync.position":
          lastSyncPosition = {
            itemId: data.itemId,
            offsetMs: data.offsetMs,
            occurrence: data.occurrence,
            videoStartOffsetMs: data.videoStartOffsetMs ?? 0,
          };
          emit(listeners.syncPosition, lastSyncPosition);
          return true;
        default:
          return false;
      }
    },
  };
  Object.defineProperty(globalThis, "__tilecastHost", {
    value: Object.freeze(host),
    configurable: false,
  });

  const bridge = {
    onPresent(callback) {
      listeners.present.push(callback);
      if (lastPresentation) callback(lastPresentation);
    },
    onPlugins(callback) {
      listeners.plugins.push(callback);
      if (lastPlugins) callback(lastPlugins);
    },
    onSyncPosition(callback) {
      listeners.syncPosition.push(callback);
      if (lastSyncPosition) callback(lastSyncPosition);
    },
    onIdentify(callback) {
      listeners.identify.push(callback);
    },
    onRetryItem(callback) {
      listeners.retry.push(callback);
    },
    onSkipItem(callback) {
      listeners.skip.push(callback);
    },
    reportProgress(itemId, kind, zoneId) {
      if (!EVIDENCE.has(kind)) return;
      reportEvidence(kind.replace(/-/g, "_"), itemId, zoneId);
    },
    reportPlaybackError(itemId, message) {
      if (!current) return;
      post({
        type: "renderer.item_error",
        activation: current,
        itemId: itemId == null ? undefined : text(itemId, 160),
        code: "playback_error",
        message: text(message, 240),
      });
    },
    // Noise Meter capture moves to a local PipeWire provider in tilecastd
    // (RFC §25.5). The WPE renderer denies microphone access, so these
    // report nothing.
    reportNoiseMeterDiagnostic() {},
    reportNoiseMeter() {},
    reportWebsiteRecovered() {},
    submitServerUrl(url) {
      if (!handlers.tilecastRequest) {
        return Promise.resolve({ ok: false, error: "Setup is not available." });
      }
      return handlers.tilecastRequest
        .postMessage({ type: "setup.submit_server_url", url: text(url, 512) })
        .then(
          (result) => ({
            ok: Boolean(result && result.ok),
            error: result && result.error,
          }),
          () => ({ ok: false, error: "tilecastd is not reachable." }),
        );
    },
    // Server discovery belongs to tilecastd (Avahi provider, RFC §22).
    onDiscoveredServer() {},
    listDiscoveredServers() {
      return Promise.resolve([]);
    },
  };
  Object.defineProperty(globalThis, "tilecast", {
    value: Object.freeze(bridge),
    configurable: false,
  });

  addEventListener("DOMContentLoaded", () => {
    afterPaint(() => post({ type: "runtime.ready" }));
  });
})();
