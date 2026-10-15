import { expect, it } from "vitest";
import { runtimeSupport } from "./support";

/**
 * Plugin API v2 host qualification. A host reports the v2 plugin host only by
 * setting `pluginState`, which means it forwards `plugin_state` entries in the
 * plugins message and grants the media they declare. These checks read each
 * host's own source for the pieces of that contract, so a host cannot claim
 * the capability without carrying it. They complement each host's own unit
 * tests (Player Core routing, Edge, Windows, Android, Browser).
 */
const wpeBridge = import.meta.glob<string>(
  "../../../../apps/edge/renderer-wpe/web/tilecast-bridge.js",
  { query: "?raw", import: "default", eager: true },
);
const browserHost = import.meta.glob<string>(
  "../../../../apps/player-web/src/host.ts",
  { query: "?raw", import: "default", eager: true },
);
const windowsHost = import.meta.glob<string>(
  "../../../../apps/player-windows/src/presentation.rs",
  { query: "?raw", import: "default", eager: true },
);
const windowsScript = import.meta.glob<string>(
  "../../../../apps/player-windows/src/runtime_host.js",
  { query: "?raw", import: "default", eager: true },
);
const androidChannel = import.meta.glob<string>(
  "../../../../apps/player-android/app/src/main/java/org/tilecast/player/runtime/HostChannel.kt",
  { query: "?raw", import: "default", eager: true },
);
const androidReport = import.meta.glob<string>(
  "../../../../apps/player-android/app/src/main/java/org/tilecast/player/core/RendererReadyReport.kt",
  { query: "?raw", import: "default", eager: true },
);
const allHosts = import.meta.glob<string>(
  [
    "../../../../apps/edge/renderer-wpe/web/*.js",
    "../../../../apps/player-web/src/**/*.ts",
    "../../../../apps/player-windows/src/**/*.rs",
    "../../../../apps/player-windows/src/**/*.js",
    "../../../../apps/player-android/app/src/main/**/*.kt",
    "../../../../apps/player-android/native/src/**/*.rs",
    "../../../../apps/edge/tilecastd/src/**/*.rs",
  ],
  { query: "?raw", import: "default", eager: true },
);

const only = (modules: Record<string, string>) => Object.values(modules)[0]!;
/** A Rust source without its inline test module, which asserts on absence. */
const code = (text: string) => text.split("#[cfg(test)]")[0]!;

it("does not report the Plugin API v2 host without a forwarding host", () => {
  expect(runtimeSupport({}, false).declarativeCapabilities).not.toHaveProperty(
    "plugin.host",
  );
});

it("every full Player host forwards plugin_state and grants its media", () => {
  expect(only(wpeBridge)).toMatch(/^\s*pluginState: true,$/m);
  expect(only(browserHost)).toMatch(/^\s*pluginState: true,$/m);
  // Windows and Android set the same capability in the host table the
  // Runtime reads before its first frame.
  expect(only(windowsHost)).toMatch(/"pluginState": true,/);
  expect(only(androidChannel)).toMatch(/pluginState:true/);
});

it("hosts that serve tcmedia://variant/ say so, and the Browser Player does not", () => {
  expect(only(wpeBridge)).toMatch(/^\s*variantMedia: true,$/m);
  expect(only(windowsHost)).toMatch(/"variantMedia": true,/);
  expect(only(androidChannel)).toMatch(/variantMedia:true/);
  // The Browser Player hands the Runtime explicit media bindings instead.
  expect(only(browserHost)).not.toMatch(/variantMedia/);
});

it("replays plugin state to a reloaded Runtime on every host that forwards it", () => {
  // A reloaded document must resume plugin state beside its presentation.
  expect(only(wpeBridge)).toMatch(/lastPlugins/);
  expect(only(windowsScript)).toMatch(/lastPlugins/);
  expect(only(androidChannel)).toMatch(/lastPlugins/);
  expect(only(browserHost)).toMatch(/listener\(plugins\)/);
});

it("native Players report the host from the shared definition, not a copy", () => {
  expect(only(androidReport)).toMatch(
    /RendererProfile\.PLUGIN_HOST_CAPABILITY/,
  );
  expect(only(androidReport)).toMatch(
    /RendererProfile\.SHARED_RUNTIME_PLAYER_SERVICES/,
  );
});

it("no host advertises plugin events before it can carry them", () => {
  // `pluginEvents` needs a transport in both directions. Until a host wires
  // one, advertising it would be untrue, and the Runtime would offer
  // `player.events` to plugins that could never use it.
  const offenders = Object.entries(allHosts)
    .filter(([, text]) => /\bpluginEvents\b/.test(code(text)))
    .map(([path]) => path);
  expect(offenders).toEqual([]);
});

it("no host source decides behavior from a plugin identifier", () => {
  const plugins = [
    "countdown_bar",
    "emergency_alerts",
    "alert_ticker",
    "forms",
  ];
  const offenders = Object.entries(allHosts)
    .filter(([path]) => !/test|\.test\./.test(path))
    .filter(([, text]) =>
      plugins.some((name) =>
        new RegExp(
          `plugin_state[^\\n]*"${name}"|"${name}"[^\\n]*plugin_state`,
        ).test(text),
      ),
    )
    .map(([path]) => path);
  expect(offenders).toEqual([]);
});
