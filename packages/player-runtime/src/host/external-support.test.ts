import { expect, it } from "vitest";
import { runtimeSupport } from "./support";

const frames = import.meta.glob<string>(
  "../../../../crates/player-types/src/frames.rs",
  { query: "?raw", import: "default", eager: true },
);
const wpeBridge = import.meta.glob<string>(
  "../../../../apps/edge/renderer-wpe/web/tilecast-bridge.js",
  { query: "?raw", import: "default", eager: true },
);
// Hosts that must not announce the plugin ABI yet.
const gatedHosts = import.meta.glob<string>(
  [
    "../../../../apps/player-windows/src/**/*.rs",
    "../../../../apps/player-android/app/src/main/**/*.kt",
    "../../../../apps/player-android/app/src/main/**/*.java",
    "../../../../apps/player-android/native/src/**/*.rs",
  ],
  { query: "?raw", import: "default", eager: true },
);

it("advertises plugin execution only when the host separately qualifies it", () => {
  expect(
    runtimeSupport({}, false, true).declarativeCapabilities,
  ).not.toHaveProperty("plugin.external-runtime");
  expect(
    runtimeSupport({}, false, false, true).declarativeCapabilities[
      "plugin.external-runtime"
    ],
  ).toBe(1);
  expect(
    runtimeSupport({}, false, false, true).widgetComponents,
  ).not.toHaveProperty("widget.external-runtime");
});

it("announces the plugin ABI version the native hosts report, only when the bridge enables it", () => {
  // The Edge heartbeat reports this constant and the packaged WPE bridge
  // enables the Runtime path; the three must change together.
  const [frameSource] = Object.values(frames);
  const version = Number(
    /EXTERNAL_PLUGIN_RUNTIME_VERSION: u32 = (\d+);/.exec(
      frameSource ?? "",
    )?.[1],
  );
  expect(
    runtimeSupport({}, false, false, true).declarativeCapabilities[
      "plugin.external-runtime"
    ],
  ).toBe(version);
  const [bridge] = Object.values(wpeBridge);
  expect(bridge).toMatch(/^\s*externalPluginFrames: true,$/m);
});

it("keeps Windows and Android plugin execution gated until they are qualified", () => {
  // Their generic frame routing exists, but neither host may announce the
  // plugin ABI before its real WebView qualification passes. Edit this test
  // only together with that qualification and the support matrix in
  // docs/external-player-plugins.md.
  const forbidden = [
    "externalPluginFrames",
    "EXTERNAL_PLUGIN_RUNTIME_CAPABILITY",
    "EXTERNAL_PLUGIN_RUNTIME_VERSION",
    "plugin.external-runtime",
  ];
  const entries = Object.entries(gatedHosts);
  expect(entries.length).toBeGreaterThan(20);
  const offenders = entries
    .filter(([, text]) => forbidden.some((token) => text.includes(token)))
    .map(([path]) => path);
  expect(offenders).toEqual([]);
});
