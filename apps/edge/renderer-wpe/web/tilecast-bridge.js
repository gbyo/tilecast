/*
 * Tilecast WPE host adapter: implements TilecastRuntimeHostV1 (the shared
 * Player Runtime's host contract, packages/player-runtime/src/host/
 * contract.ts) on two WebKit script message handlers owned by
 * tilecast-renderer-wpe.
 *
 * Injected by the renderer host at document start, top frame only, and only
 * on tilecast://runtime/ pages. Remote content never sees it.
 *
 *   host → page: globalThis.__tilecastHost.receive(name, json)
 *   page → host: webkit.messageHandlers.tilecast.postMessage({type, ...})
 *                webkit.messageHandlers.tilecastRequest.postMessage({...})
 *
 * This file only translates. It holds no presentation policy: projection,
 * timing, transitions and evidence all belong to the runtime. The page never
 * names paths, commands or credentials. Reports are tagged with the activation
 * the runtime is actually showing, so the daemon can discard reports that
 * belong to a replaced presentation.
 */
(() => {
  "use strict";

  const handlers = globalThis.webkit && globalThis.webkit.messageHandlers;
  if (!handlers || !handlers.tilecast) {
    return;
  }
  const post = (message) => handlers.tilecast.postMessage(message);
  const text = (value, max) => String(value == null ? "" : value).slice(0, max);

  const listeners = new Set();
  let current = null; // { activationId, generation } the runtime was given
  let lastPresentation = null;
  let lastPlugins = null;

  const emit = (message) => {
    if (message.type === "presentation") lastPresentation = message;
    if (message.type === "plugins") lastPlugins = message;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("tilecast host listener failed", error);
      }
    }
  };

  const sameActivation = (a, b) =>
    !!a &&
    !!b &&
    a.activationId === b.activationId &&
    a.generation === b.generation;

  // The IPC contract uses the runtime's evidence vocabulary in snake_case
  // (edge_protocol::ipc::event::EvidenceKind).
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
    "surface-shown",
  ]);

  const activate = (data) => {
    const activation = {
      activationId: text(data.activationId, 36),
      generation: Number(data.generation),
    };
    if (sameActivation(current, activation)) {
      // The daemon re-sends the current activation after a reconnect; the
      // runtime is already showing it.
      post({ type: "presentation.accepted", activation: current });
      return;
    }
    current = activation;
    const message = {
      type: "presentation",
      presentation: data.presentation,
      activation,
    };
    const timing = data.timing;
    if (timing && typeof timing === "object") {
      message.timing = {
        groupId: timing.groupId,
        anchorMs: timing.anchorUnixMs,
        durationsMs: timing.durationsMs,
        clockOffsetMs: timing.clockOffsetMs,
      };
    }
    if (data.projection && typeof data.projection === "object") {
      message.projection = data.projection;
    }
    emit(message);
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
          activate(data);
          return true;
        case "plugin.state":
          emit({
            type: "plugins",
            plugins: data.plugins,
            clockOffsetMs: data.clockOffsetMs,
          });
          return true;
        case "presentation.clear":
          current = null;
          emit({ type: "presentation", presentation: { state: "sleep" } });
          return true;
        case "presentation.identify":
          emit({
            type: "identify",
            name: data.name,
            durationSeconds: data.durationSeconds,
          });
          return true;
        case "renderer.command":
          if (data.command === "retry_item")
            emit({ type: "command", command: "retry-item" });
          if (data.command === "skip_item")
            emit({ type: "command", command: "skip-item" });
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

  const engineVersion =
    (/AppleWebKit\/([0-9.]+)/.exec(navigator.userAgent) || [])[1] || "";

  const runtimeHost = {
    contractVersion: 1,
    info: Object.freeze({
      host: "wpe",
      hostVersion: "",
      engine: "webkit",
      engineVersion,
    }),
    capabilities: Object.freeze({
      // Remote websites need the isolated host view (M11) before they are
      // offered; until then they are typed incompatibilities in tilecastd.
      remoteWeb: null,
      synchronizedPlayback: false,
      setup: !!handlers.tilecastRequest,
      // tilecastd browses Avahi; an empty list is a valid answer.
      discovery: !!handlers.tilecastRequest,
      // Noise Meter capture moves to a PipeWire provider in tilecastd (M9);
      // this renderer denies microphone access.
      noiseMeter: null,
    }),
    subscribe(listener) {
      listeners.add(listener);
      if (lastPresentation) listener(lastPresentation);
      if (lastPlugins) listener(lastPlugins);
      return () => listeners.delete(listener);
    },
    ready() {
      post({ type: "runtime.ready" });
    },
    presentationResult(result) {
      if (!result.activation || !sameActivation(result.activation, current))
        return;
      if (result.outcome === "accepted") {
        post({ type: "presentation.accepted", activation: current });
      } else {
        post({
          type: "presentation.rejected",
          activation: current,
          code: text(result.code || "runtime_error", 64),
          message: text(result.message, 240),
        });
      }
    },
    reportEvidence(report) {
      if (!report.activation || !sameActivation(report.activation, current))
        return;
      if (!EVIDENCE.has(report.kind)) return;
      const message = {
        type: "renderer.progress",
        activation: current,
        kind: report.kind.replace(/-/g, "_"),
      };
      if (report.itemId != null) message.itemId = text(report.itemId, 160);
      if (report.zoneId != null) message.zoneId = text(report.zoneId, 160);
      post(message);
    },
    reportPlaybackError(report) {
      if (!report.activation || !sameActivation(report.activation, current))
        return;
      const message = {
        type: "renderer.item_error",
        activation: current,
        code: "playback_error",
        message: text(report.message, 240),
      };
      if (report.itemId != null) message.itemId = text(report.itemId, 160);
      post(message);
    },
    setup: Object.freeze({
      submitServerUrl(url) {
        if (!handlers.tilecastRequest) {
          return Promise.resolve({
            ok: false,
            error: "Setup is not available.",
          });
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
    }),
    discovery: Object.freeze({
      list() {
        if (!handlers.tilecastRequest) return Promise.resolve([]);
        return handlers.tilecastRequest
          .postMessage({ type: "discovery.list" })
          .then(
            (result) =>
              Array.isArray(result && result.servers)
                ? result.servers.slice(0, 32).map((server) => ({
                    name: text(server.name, 120),
                    serverUrl: text(server.serverUrl, 512),
                  }))
                : [],
            () => [],
          );
      },
    }),
  };
  Object.defineProperty(globalThis, "tilecastRuntimeHost", {
    value: Object.freeze(runtimeHost),
    configurable: false,
  });
})();
