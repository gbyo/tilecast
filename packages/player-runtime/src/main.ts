/**
 * Entry point of the shared Tilecast Player Runtime (runtime.js).
 *
 * Finds the host's TilecastRuntimeHostV1 bridge, starts the playback engine
 * and the plugin surface host, binds the views, and tells the host it is ready.
 * If the bridge is missing or speaks another contract version, the display
 * says so on screen instead of staying silently black.
 */
import {
  hostContractProblem,
  RUNTIME_HOST_CONTRACT_VERSION,
  RUNTIME_HOST_GLOBAL,
  type HostMessageV1,
  type TilecastRuntimeHostV1,
} from "./host/contract";
import {
  browserClock,
  ManualClock,
  type RuntimeClock,
} from "./clock/scheduler";
import { PlaybackController } from "./engine/controller";
import { runtimeDiscovery } from "./plugins/discovery";
import { RuntimeSurfaceHost } from "./plugins/host";
import { MicrophoneService } from "./plugins/microphone";
import { installProbe } from "./probe";
import { PlayerRoot } from "./views/player-root";

declare const __RUNTIME_VERSION__: string;
const RUNTIME_VERSION =
  typeof __RUNTIME_VERSION__ === "string" ? __RUNTIME_VERSION__ : "dev";

function root(): PlayerRoot {
  const existing = document.querySelector("tc-player");
  if (existing instanceof PlayerRoot) return existing;
  const created = new PlayerRoot();
  document.body.appendChild(created);
  return created;
}

function start(): void {
  const view = root();
  const host = (globalThis as Record<string, unknown>)[RUNTIME_HOST_GLOBAL];
  const problem = hostContractProblem(host);
  if (problem) {
    view.showProblem(problem);
    console.error(`tilecast runtime: ${problem}`);
    return;
  }
  run(view, host as TilecastRuntimeHostV1);
}

function run(view: PlayerRoot, host: TilecastRuntimeHostV1): void {
  const conformance = host.conformance ?? null;
  const manual = conformance
    ? new ManualClock({ wallMs: conformance.wallClockMs })
    : null;
  const clock: RuntimeClock = manual ?? browserClock();
  const animationScale = conformance ? conformance.animationScale : 1;
  const capabilities = host.capabilities;
  if (conformance) document.documentElement.classList.add("tc-conformance");

  const controller = new PlaybackController({
    clock,
    synchronizedPlayback: capabilities.synchronizedPlayback,
    reports: {
      evidence: (activation, kind, itemId, zoneId) =>
        host.reportEvidence({
          activation,
          kind,
          itemId,
          ...(zoneId ? { zoneId } : {}),
        }),
      playbackError: (activation, itemId, message) =>
        host.reportPlaybackError({ activation, itemId, message }),
      presentationResult: (result) => host.presentationResult(result),
      websiteRecovered: () => host.remoteWeb?.reportRecovered(),
    },
  });
  for (const problem of runtimeDiscovery.problems) {
    console.error(`tilecast runtime: plugin discovery: ${problem}`);
  }
  const microphone = new MicrophoneService({
    source: capabilities.noiseMeter,
    clock,
    report: (report) => host.noiseMeter?.report(report),
    diagnostic: (message, detail) =>
      host.noiseMeter?.diagnostic(message, detail),
  });
  const surfaces = new RuntimeSurfaceHost({
    clock,
    plugins: runtimeDiscovery.plugins,
    animationScale,
    reducedMotion: () =>
      animationScale === 0 ||
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    microphone,
    mediaUrl: (assetId, variantId) =>
      `tcmedia://variant/${assetId}/${variantId}`,
    stage: () => document.getElementById("content-stage"),
    diagnostic: (pluginId, message) =>
      console.warn(`tilecast runtime: plugin ${pluginId}: ${message}`),
  });

  view.bind({
    controller,
    surfaces,
    clock,
    capabilities,
    animationScale,
    setup: {
      available: capabilities.setup && !!host.setup,
      submit: (url) =>
        host.setup
          ? host.setup.submitServerUrl(String(url).slice(0, 512))
          : Promise.resolve({ ok: false, error: "Setup is not available." }),
    },
  });

  installProbe({
    version: RUNTIME_VERSION,
    host,
    controller,
    surfaces,
    view,
    manual,
  });

  const receive = (message: HostMessageV1) => {
    switch (message.type) {
      case "presentation":
        surfaces.setAwake(message.presentation.state !== "sleep");
        controller.present(message);
        break;
      case "plugins":
        surfaces.setEntries(message.plugins, message.clockOffsetMs);
        break;
      case "identify":
        view.identify(String(message.name), Number(message.durationSeconds));
        break;
      case "command":
        if (message.command === "retry-item") controller.retry();
        if (message.command === "skip-item") controller.skip();
        break;
      case "discovered-server":
        view.addServer(message.server);
        break;
      case "noise-level":
        microphone.hostLevel(message.rms);
        break;
    }
  };
  host.subscribe((message) => {
    try {
      receive(message);
    } catch (error) {
      console.error("tilecast runtime: host message failed", error);
    }
  });
  if (capabilities.discovery && host.discovery) {
    void host.discovery
      .list()
      .then((servers) => servers.forEach((server) => view.addServer(server)))
      .catch(() => undefined);
  }
  // A reload replaces this document; the microphone goes with it.
  addEventListener("pagehide", () => surfaces.stop());

  // Ready once the first frame is painted with the bundled font available,
  // so the host never activates content into a document that cannot draw.
  const fonts = document.fonts?.ready ?? Promise.resolve();
  void Promise.all([view.updateComplete, fonts]).then(() =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        host.ready({
          contractVersion: RUNTIME_HOST_CONTRACT_VERSION,
          runtimeVersion: RUNTIME_VERSION,
        }),
      ),
    ),
  );
}

if (document.readyState === "loading") {
  addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
