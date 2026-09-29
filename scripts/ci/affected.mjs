import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Edges name consumers, not directories. A catalog reaches Studio and the
// server; a renderer reaches its hosts without rebuilding installer images.
export const graph = {
  dashboard: ["container", "e2e"],
  server: ["container", "e2e"],
  cli: [],
  plugins: [],
  ci: [],
  widgets: ["dashboard", "runtime", "server", "docs"],
  sources: ["dashboard", "server", "plugins", "docs"],
  runtime: ["linux", "edge_runtime", "edge_wpe", "edge_conformance"],
  linux: ["edge_runtime", "edge_conformance"],
  protocol: ["server", "android", "runtime", "edge_rust", "edge_server"],
  activity: ["protocol", "edge_activity"],
  android: [],
  docs: [],
  container: [],
  e2e: [],
  edge_rust: [],
  edge_wpe: [],
  edge_runtime: [],
  edge_conformance: [],
  edge_server: [],
  edge_migration: [],
  edge_activity: [],
};
export const areas = Object.keys(graph);
const edgeAreas = areas.filter((area) => area.startsWith("edge_"));

// Rules compose: a protocol file inside the server selects both rules.
const rules = [
  [/^apps\/dashboard\//, ["dashboard"]],
  [/^apps\/server\//, ["server"]],
  [/^(apps\/cli|packages\/api-client)\//, ["cli"]],
  [/^apps\/player-android\//, ["android"]],
  [
    /^scripts\/(build-player-release|extract-apksigner-sha256)\.sh$/,
    ["android"],
  ],
  [
    /^(apps\/player-linux\/|scripts\/(build-linux-player-release\.sh|verify-linux-player-release\.mjs)$)/,
    ["linux"],
  ],
  [/^packages\/player-runtime\//, ["runtime"]],
  [/^(widgets|packages\/widget-sdk|packages\/widget-kit)\//, ["widgets"]],
  [/^(data-sources|packages\/data-source-sdk)\//, ["sources"]],
  [/^packages\/design-tokens\//, ["dashboard", "docs"]],
  // These packages contain transport JSON, not shared application code.
  // README/metadata edits do not change the player wire contract.
  [
    /^packages\/(layout-schema|manifest-schema|settings-schema)\/(schema-v\d+|schedule-fixtures|player-config-v\d+)\.json$/,
    ["protocol", "dashboard"],
  ],
  [
    /^packages\/(api-schema|layout-schema|manifest-schema|settings-schema)\/package\.json$/,
    ["server", "dashboard", "cli", "docs"],
  ],
  [/^packages\/api-schema\/activity\//, ["activity"]],
  [
    /^apps\/server\/internal\/(devices|manifestchanges|previews|settings|presentnet)\//,
    ["protocol"],
  ],
  // The manifest builder and playback validation are shared with Players.
  // Editorial CRUD/list previews remain ordinary server/Studio contracts.
  [
    /^apps\/server\/internal\/playlists\/(service|types|presentation|capabilities|component|invalidation|source_availability)(_[^/]+)?\.go$/,
    ["protocol"],
  ],
  [
    /^apps\/server\/internal\/layouts\/(types|validate)(_[^/]+)?\.go$/,
    ["protocol"],
  ],
  [
    /^apps\/server\/internal\/scheduling\/(engine|display_mode)(_[^/]+)?\.go$/,
    ["protocol"],
  ],
  // Files with authenticated Player endpoints, their decoders, or shared
  // routing/authentication. A contract test audits every Player handler.
  [
    /^apps\/server\/internal\/httpapi\/(devices|player_socket|player_manifest|player_config|player_media|heartbeat_decode|heartbeat_json|pairing_json|manifest_integration|retired_heartbeat_integration|operations|display_control|airplay|airplay_reconcile|live_stream|span|previews|updates|presentation_networks|presentation_overrides|routes|server|middleware|principal)(_[^/]+)?\.go$/,
    ["protocol"],
  ],
  [
    /^apps\/server\/internal\/httpapi\/(activity|telemetry|incident|expected_playback)(_[^/]+)?\.go$/,
    ["activity"],
  ],
  [/^apps\/server\/internal\/(activity|telemetry)\//, ["activity"]],
  [/^plugins\/[^/]+\/studio\//, ["plugins", "dashboard"]],
  [/^plugins\/[^/]+\/runtime\//, ["plugins", "runtime"]],
  [
    /^plugins\/[^/]+\/(widgets|data-sources)\//,
    ["plugins", "widgets", "sources"],
  ],
  [/^plugins\/.*\.go$/, ["plugins", "server"]],
  [/^plugins\/[^/]+\/(migrations|api)\//, ["plugins", "server", "docs", "cli"]],
  [
    /^plugins\/[^/]+\/tilecast\.plugin\.json$/,
    ["plugins", "widgets", "sources", "runtime"],
  ],
  [
    /^packages\/plugin-sdk\//,
    [
      "plugins",
      "server",
      "dashboard",
      "runtime",
      "widgets",
      "sources",
      "docs",
      "cli",
    ],
  ],
  [/^packages\/edge-protocol\//, edgeAreas],
  [/^apps\/edge\/(tilecastd|tilecastctl|crates)\//, ["edge_rust"]],
  [
    /^apps\/edge\/(renderer-wpe|web-renderer-wpe|session-bridge)\//,
    ["edge_wpe", "edge_conformance", "edge_server"],
  ],
  [
    /^apps\/edge\/(packaging|release|tilecast-edge-migrate|tilecast-edge-update)\//,
    ["edge_rust", "edge_migration"],
  ],
  [
    /^apps\/edge\/tilecastd\/.*(server_link|manifest|pairing|config_sync|commands|network|media|ipc)/,
    ["edge_server"],
  ],
  [
    /^apps\/edge\/tilecastd\/.*(activity|telemetry|playback|presentation)/,
    ["edge_activity", "edge_wpe"],
  ],
  [/^apps\/edge\/tilecastd\/.*(legacy|update)/, ["edge_migration"]],
  [/^apps\/edge\/ci\//, edgeAreas],
  [/^apps\/edge\/[^/]+$/, edgeAreas],
  [/^deploy\/docker\//, ["container", "e2e"]],
  [/^\.dockerignore$/, ["container", "e2e"]],
  [/^\.(prettierignore|prettierrc(?:\.[^/]+)?)$/, ["dashboard", "docs"]],
  [/^(e2e\/|scripts\/demo-reset\.sh$)/, ["e2e"]],
  [
    /^(apps\/docs\/|docs\/|wiki\/|\.github\/logos\/)|(^|\/)README\.md$|^CONTRIBUTING\.md$|^scripts\/check-docs-ste\.sh$/,
    ["docs"],
  ],
  [/^docs\/(openapi\/|openapi\.yaml$)/, ["plugins", "cli", "server"]],
  [
    /^(package(-lock)?\.json|go\.work(\.sum)?|Makefile|\.github\/CODEOWNERS)$|^\.github\/(workflows|actions)\/|^scripts\/ci\//,
    areas,
  ],
];

export function affected(paths, { full = false, fullEdge = false } = {}) {
  const selected = new Set(full ? areas : []);
  for (const path of paths) {
    // Package READMEs explain a contract; they do not compile into it.
    if (/(^|\/)README\.md$/.test(path)) {
      selected.add("docs");
      continue;
    }
    let matched = false;
    for (const [pattern, targets] of rules) {
      if (!pattern.test(path)) continue;
      matched = true;
      for (const target of targets) selected.add(target);
    }
    // New shared packages/plugins must get validation until their consumers
    // have been added deliberately. Unknown documentation is inexpensive.
    if (!matched && /^(packages|plugins|apps\/edge)\//.test(path)) {
      for (const area of areas) selected.add(area);
    }
  }
  for (const area of selected) {
    for (const consumer of graph[area]) selected.add(consumer);
  }
  if (fullEdge && edgeAreas.some((area) => selected.has(area))) {
    for (const area of edgeAreas) selected.add(area);
  }
  return Object.fromEntries(areas.map((area) => [area, selected.has(area)]));
}

export function changedPaths(base, head, { cwd } = {}) {
  if (!base || !head) throw new Error("Both --base and --head are required.");
  // NUL delimiters preserve spaces/newlines. Three dots excludes base-branch
  // changes from stacked PRs and includes renamed/deleted source paths.
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
    { encoding: "utf8", cwd },
  )
    .split("\0")
    .filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const value = (flag) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const paths = args.includes("--full")
    ? []
    : args.includes("--base")
      ? changedPaths(value("--base"), value("--head"))
      : args.filter((arg) => !["--github-output", "--edge-full"].includes(arg));
  const result = affected(paths, {
    full: args.includes("--full"),
    fullEdge: args.includes("--edge-full"),
  });
  if (args.includes("--github-output")) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
  console.log(JSON.stringify(result, null, 2));
}
