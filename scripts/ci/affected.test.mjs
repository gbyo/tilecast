import assert from "node:assert/strict";
import { test } from "node:test";
import { affected, areas } from "./affected.mjs";

const selected = (paths) =>
  Object.entries(affected(paths))
    .filter(([, value]) => value)
    .map(([key]) => key)
    .sort();
test("Studio selects the real stack without Edge or Android", () => {
  assert.deepEqual(selected(["apps/dashboard/src/components/Button.tsx"]), [
    "container",
    "dashboard",
    "e2e",
  ]);
});
test("CLI and MCP select their module without a server image", () => {
  assert.deepEqual(selected(["apps/cli/internal/cli/mcp.go"]), ["cli"]);
});
test("installer runs Rust and migration without Studio", () => {
  assert.deepEqual(selected(["apps/edge/packaging/tilecastd.service"]), [
    "edge_migration",
    "edge_rust",
  ]);
});
test("runtime semantics select both renderers but no migration", () => {
  assert.deepEqual(selected(["packages/player-runtime/src/widgets/host.ts"]), [
    "edge_conformance",
    "edge_runtime",
    "edge_wpe",
    "linux",
    "runtime",
  ]);
});
test("Widgets reach the catalog, Studio and production hosts", () => {
  const result = affected(["widgets/clock/runtime.ts"]);
  for (const area of [
    "widgets",
    "server",
    "dashboard",
    "e2e",
    "edge_wpe",
    "edge_conformance",
  ])
    assert.equal(result[area], true, area);
  assert.equal(result.edge_migration, false);
  assert.equal(result.android, false);
});
test("plugin surfaces follow their consumers", () => {
  assert.deepEqual(selected(["plugins/weather/studio/Page.tsx"]), [
    "container",
    "dashboard",
    "e2e",
    "plugins",
  ]);
  assert.equal(
    affected(["plugins/weather/runtime/render.ts"]).edge_conformance,
    true,
  );
  assert.equal(affected(["plugins/weather/service.go"]).server, true);
});
test("new data source catalog has server, Studio and conformance", () => {
  const result = affected([
    "data-sources/announcements/tilecast.datasource.json",
  ]);
  for (const area of ["sources", "server", "dashboard", "plugins", "e2e"])
    assert.equal(result[area], true);
});
test("protocol and activity include integration boundaries", () => {
  assert.equal(
    affected(["apps/server/internal/devices/manifest.go"]).edge_server,
    true,
  );
  assert.equal(
    affected(["packages/api-schema/activity/events.json"]).edge_activity,
    true,
  );
});
test("documentation stays inexpensive", () => {
  assert.deepEqual(selected(["docs/deployment.md"]), ["docs"]);
});
test("graph, workflows, lockfiles and unknown shared packages fail conservative", () => {
  for (const path of [
    "scripts/ci/affected.mjs",
    ".github/workflows/pr-validation.yml",
    "package-lock.json",
    "packages/new-contract/index.ts",
  ])
    assert.deepEqual(selected([path]), [...areas].sort());
});
test("full run and empty diff", () => {
  assert.deepEqual(
    affected([], { full: true }),
    Object.fromEntries(areas.map((area) => [area, true])),
  );
  assert.deepEqual(selected([]), []);
});
test("main expands relevant Edge changes, while docs stay inexpensive", () => {
  assert.equal(
    affected(["apps/edge/tilecastd/src/config.rs"], { fullEdge: true })
      .edge_migration,
    true,
  );
  assert.equal(
    affected(["docs/deployment.md"], { fullEdge: true }).edge_migration,
    false,
  );
});
