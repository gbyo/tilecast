import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  renameSync,
  readFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { affected, areas, changedPaths } from "./affected.mjs";

const selected = (paths) =>
  Object.entries(affected(paths))
    .filter(([, value]) => value)
    .map(([key]) => key)
    .sort();
test("root Rust inputs and shared crates select portable and Edge validation", () => {
  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "rustfmt.toml",
    ".cargo/config.toml",
    "crates/player-types/src/lib.rs",
  ]) {
    const result = affected([path]);
    for (const area of [
      "player_core",
      "ci",
      "edge_rust",
      "edge_server",
      "edge_migration",
      "edge_activity",
      "edge_wpe",
      "edge_conformance",
    ])
      assert.equal(result[area], true, `${path}: ${area}`);
    assert.equal(result.ios, false, path);
    assert.equal(result.android, false, path);
    assert.equal(result.server, false, path);
  }
  for (const path of [
    "crates/future/Cargo.toml",
    "crates/player-unregistered/src/lib.rs",
    "scripts/ci/check-player-architecture.py",
  ])
    assert.deepEqual(selected([path]), [...areas].sort(), path);
  assert.equal(
    affected(["apps/edge/crates/edge-platform/src/systemd.rs"]).player_core,
    false,
  );
  assert.equal(affected(["docs/player-core.md"]).ci, true);
});
test("Player crates require root workspace registration before narrowing validation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tilecast-player-registry-"));
  try {
    mkdirSync(join(cwd, "crates/player-types"), { recursive: true });
    writeFileSync(
      join(cwd, "crates/player-types/Cargo.toml"),
      '[package]\nname = "player-types"\nversion = "0.1.0"\n',
    );
    const path = "crates/player-types/src/lib.rs";
    for (const workspace of [
      "[workspace]\nmembers = []\n",
      '[workspace]\nmembers = ["crates/player-*"]\nexclude = ["crates/player-types"]\n',
    ]) {
      writeFileSync(join(cwd, "Cargo.toml"), workspace);
      assert.deepEqual(affected([path], { cwd }), affected([], { full: true }));
    }
    for (const members of ['"crates/player-types"', '"crates/player-*"']) {
      writeFileSync(
        join(cwd, "Cargo.toml"),
        `[workspace]\nmembers = [${members}]\n`,
      );
      const result = affected([path], { cwd });
      assert.equal(result.player_core, true);
      assert.equal(result.ios, false);
      assert.equal(result.server, false);
    }
    writeFileSync(join(cwd, "Cargo.toml"), "invalid TOML");
    assert.deepEqual(affected([path], { cwd }), affected([], { full: true }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("Studio selects the real stack without Edge or Android", () => {
  assert.deepEqual(selected(["apps/dashboard/src/components/Button.tsx"]), [
    "container",
    "dashboard",
    "e2e",
  ]);
});
test("iOS host selects only its own validation", () => {
  assert.deepEqual(selected(["apps/ios/Tilecast/App/RootView.swift"]), ["ios"]);
  assert.deepEqual(
    selected([
      "apps/ios/TilecastKit/Sources/TilecastCore/Web/StudioPage.swift",
    ]),
    ["ios"],
  );
});
test("Studio and server changes do not build the iOS host", () => {
  for (const path of [
    "apps/dashboard/src/components/Button.tsx",
    "apps/dashboard/src/navigation/routes.ts",
    "apps/dashboard/src/navigation/studioNavigation.tsx",
    "apps/dashboard/src/native-host/useNativeNavigation.ts",
    "apps/dashboard/src/native-presentation/NativePresentationHost.tsx",
    "apps/dashboard/src/pages/RoomBookingsPage.tsx",
    "apps/dashboard/src/styles.css",
    "apps/dashboard/src/App.tsx",
    "apps/server/internal/httpapi/devices.go",
    "plugins/weather/studio/Page.tsx",
    "plugins/forms/studio/index.tsx",
  ])
    assert.equal(affected([path]).ios, false, path);
});
test("the native bridge contract selects Studio and the iOS host", () => {
  for (const path of [
    "packages/native-bridge-schema/schema-v1.json",
    "packages/native-bridge-schema/fixtures/messages-v1.json",
    "packages/native-bridge-schema/icon-tokens.json",
    "packages/native-bridge-schema/package.json",
  ]) {
    const result = affected([path]);
    assert.equal(result.ios, true, `${path}: ios`);
    assert.equal(result.dashboard, true, `${path}: dashboard`);
    // A contract change is not a Player, Edge, or server change.
    for (const area of ["server", "android", "runtime", "edge_rust"])
      assert.equal(result[area], false, `${path}: ${area}`);
  }
  // A README explains the contract and does not compile into it.
  assert.deepEqual(selected(["packages/native-bridge-schema/README.md"]), [
    "docs",
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
test("ordinary server business logic and dashboard HTTP do not select players", () => {
  for (const path of [
    "apps/server/internal/httpapi/settings.go",
    "apps/server/internal/httpapi/users.go",
    "apps/server/internal/httpapi/userauth.go",
    "apps/server/internal/httpapi/oauth.go",
    "apps/server/internal/httpapi/mfa.go",
    "apps/server/internal/httpapi/backups.go",
    "apps/server/internal/httpapi/notifications.go",
    "apps/server/internal/httpapi/github_configuration.go",
    "apps/server/internal/httpapi/content_organization.go",
    "apps/server/internal/httpapi/media.go",
    "apps/server/internal/httpapi/playlists.go",
    "apps/server/internal/playlists/editorial_workflow_integration_test.go",
    "apps/server/internal/layouts/editorial.go",
    "apps/server/internal/auth/passwords.go",
    "apps/server/internal/scheduling/service.go",
  ])
    assert.deepEqual(selected([path]), ["container", "e2e", "server"], path);
});
test("device APIs and manifest/config producers select player consumers", () => {
  for (const path of [
    "apps/server/internal/httpapi/player_socket.go",
    "apps/server/internal/httpapi/heartbeat_decode.go",
    "apps/server/internal/httpapi/heartbeat_json_test.go",
    "apps/server/internal/httpapi/pairing_json_test.go",
    "apps/server/internal/httpapi/devices.go",
    "apps/server/internal/httpapi/player_manifest.go",
    "apps/server/internal/httpapi/operations.go",
    "apps/server/internal/httpapi/player_config.go",
    "apps/server/internal/httpapi/player_media.go",
    "apps/server/internal/playlists/service.go",
    "apps/server/internal/settings/service.go",
    "apps/server/internal/scheduling/engine.go",
  ]) {
    const result = affected([path]);
    for (const area of [
      "server",
      "android",
      "runtime",
      "linux",
      "edge_rust",
      "edge_server",
      "edge_conformance",
    ])
      assert.equal(result[area], true, `${path}: ${area}`);
    assert.equal(result.edge_migration, false, path);
  }
});
test("every HTTP Player handler has a player consumer mapping", () => {
  const directory = "apps/server/internal/httpapi";
  for (const file of readdirSync(directory).filter(
    (file) => file.endsWith(".go") && !file.endsWith("_test.go"),
  )) {
    // install.go serves OS installer files, not the authenticated device API.
    if (file === "install.go") continue;
    const source = readFileSync(`${directory}/${file}`, "utf8");
    if (
      !/func \(s \*server\) (player[A-Z]|createPairingSession|pollPairingSession|enrollPlayer|requireDevice)/.test(
        source,
      )
    )
      continue;
    assert.equal(affected([`${directory}/${file}`]).edge_server, true, file);
  }
});
test("activity ingestion, derivation and shared evidence select parity", () => {
  for (const path of [
    "apps/server/internal/httpapi/activity_ingest.go",
    "apps/server/internal/httpapi/activity_proof.go",
    "apps/server/internal/httpapi/telemetry_ingest.go",
    "apps/server/internal/httpapi/incident_derivation.go",
    "apps/server/internal/httpapi/expected_playback.go",
    "packages/api-schema/activity/player-parity.json",
  ])
    assert.equal(affected([path]).edge_activity, true, path);
});
test("player contract sources select every native consumer and their drift gate", () => {
  for (const path of [
    "packages/manifest-schema/presentation-capabilities.json",
    "packages/player-contracts/fixtures/server-url-policy.json",
    "scripts/generate-player-contracts.mjs",
  ]) {
    const result = affected([path]);
    if (path.endsWith("server-url-policy.json"))
      assert.equal(result.ios, true, `${path}: ios`);
    for (const area of [
      "ci",
      "server",
      "android",
      "runtime",
      "linux",
      "edge_rust",
      "edge_server",
      "edge_wpe",
      "edge_conformance",
    ])
      assert.equal(result[area], true, `${path}: ${area}`);
  }
});
test("shared schema contracts distinguish players from ordinary API consumers", () => {
  for (const path of [
    "packages/manifest-schema/schema-v16.json",
    "packages/manifest-schema/schedule-fixtures.json",
    "packages/layout-schema/schema-v2.json",
    "packages/settings-schema/player-config-v1.json",
  ])
    assert.equal(affected([path]).edge_server, true, path);
  assert.deepEqual(selected(["packages/api-schema/package.json"]), [
    "cli",
    "container",
    "dashboard",
    "docs",
    "e2e",
    "server",
  ]);
  for (const path of [
    "packages/api-schema/README.md",
    "packages/manifest-schema/README.md",
    "packages/settings-schema/README.md",
  ])
    assert.deepEqual(selected([path]), ["docs"], path);
});
test("OpenAPI contract changes run server route parity", () => {
  for (const path of ["docs/openapi/core.yaml", "docs/openapi.yaml"]) {
    const result = affected([path]);
    assert.equal(result.plugins, true, `${path}: plugins`);
    assert.equal(result.cli, true, `${path}: cli`);
    assert.equal(result.server, true, `${path}: server`);
    // The iOS app generates its API client from the composed contract.
    assert.equal(result.ios, true, `${path}: ios`);
  }
});

test("documentation stays inexpensive", () => {
  assert.deepEqual(selected(["docs/deployment.md"]), ["docs"]);
  for (const path of [
    "apps/server/README.md",
    "apps/edge/README.md",
    "widgets/clock/README.md",
    "packages/plugin-sdk/README.md",
  ])
    assert.deepEqual(selected([path]), ["docs"], path);
});
test("graph, workflows, lockfiles and unknown shared packages fail conservative", () => {
  for (const path of [
    "scripts/ci/affected.mjs",
    ".github/workflows/pr-validation.yml",
    "package-lock.json",
    "packages/new-contract/index.ts",
    "packages/api-schema/new-contract.json",
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
test("actual stacked base excludes base-only commits and retains rename/delete paths", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tilecast-ci-graph-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init");
    git("config", "user.name", "CI contract test");
    git("config", "user.email", "ci@example.invalid");
    writeFileSync(join(cwd, "old name.ts"), "base");
    git("add", ".");
    git("commit", "-m", "base");
    git("branch", "stack-base");
    git("switch", "-c", "topic");
    renameSync(join(cwd, "old name.ts"), join(cwd, "new name.ts"));
    writeFileSync(join(cwd, "new name.ts"), "head");
    git("add", ".");
    git("commit", "-m", "rename on topic");
    const head = git("rev-parse", "HEAD");
    git("switch", "stack-base");
    writeFileSync(join(cwd, "base-only.ts"), "unrelated");
    git("add", ".");
    git("commit", "-m", "base advances");
    assert.deepEqual(changedPaths("stack-base", head, { cwd }).sort(), [
      "new name.ts",
      "old name.ts",
    ]);
    assert.throws(() => changedPaths(undefined, head), /Both/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
