import { expect, it } from "vitest";
import { runtimeSupport } from "./support";

const wpeBridge = import.meta.glob<string>(
  "../../../../apps/edge/renderer-wpe/web/tilecast-bridge.js",
  { query: "?raw", import: "default", eager: true },
);
const browserHost = import.meta.glob<string>(
  "../../../../apps/player-web/src/host.ts",
  { query: "?raw", import: "default", eager: true },
);
// Hosts that route plugin_state but must not report the v2 host yet.
const gatedHosts = import.meta.glob<string>(
  [
    "../../../../apps/player-windows/src/**/*.rs",
    "../../../../apps/player-android/app/src/main/**/*.kt",
    "../../../../apps/player-android/app/src/main/**/*.java",
    "../../../../apps/player-android/native/src/**/*.rs",
  ],
  { query: "?raw", import: "default", eager: true },
);

it("reports the Plugin API v2 host only through a forwarding host", () => {
  expect(runtimeSupport({}, false).declarativeCapabilities).not.toHaveProperty(
    "plugin.host",
  );
  const [bridge] = Object.values(wpeBridge);
  expect(bridge).toMatch(/^\s*pluginState: true,$/m);
  const [browser] = Object.values(browserHost);
  expect(browser).toMatch(/^\s*pluginState: true,$/m);
});

it("keeps Windows and Android v2 reporting gated until they are qualified", () => {
  // Both route plugin_state through Player Core and grant its media, so a
  // future manifest cannot break them. Neither reports the v2 host before
  // its real WebView qualification passes. Edit this test only together with
  // that qualification and the support matrix in docs/plugin-api-v2.md.
  const forbidden = [
    "pluginState",
    "shared_runtime_plugin_capabilities",
    "PLAYER_PLUGIN_HOST_CAPABILITY",
    '"plugin.host"',
  ];
  const entries = Object.entries(gatedHosts);
  expect(entries.length).toBeGreaterThan(20);
  const offenders = entries
    .filter(([, text]) => forbidden.some((token) => text.includes(token)))
    .map(([path]) => path);
  expect(offenders).toEqual([]);
});
