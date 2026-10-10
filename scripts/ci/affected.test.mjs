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
import { fileURLToPath } from "node:url";
import {
  affected,
  areas,
  changedPaths,
  linuxReleaseContractRequired,
} from "./affected.mjs";

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
      "android",
      "ci",
      "edge_rust",
      "edge_server",
      "edge_migration",
      "edge_activity",
      "edge_wpe",
      "edge_conformance",
      "windows",
    ])
      assert.equal(result[area], true, `${path}: ${area}`);
    assert.equal(result.ios, false, path);
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
    "browser_player",
    "edge_conformance",
    "edge_runtime",
    "edge_wpe",
    "linux",
    "runtime",
    "windows",
  ]);
});
test("the Windows host selects only Windows validation", () => {
  for (const path of [
    "apps/player-windows/src/main.rs",
    "apps/player-windows/release/AppxManifest.xml.template",
    "apps/player-windows/release/stage-windows-release.py",
  ])
    assert.deepEqual(selected([path]), ["windows"], path);
  assert.equal(affected(["apps/player-windows/src/main.rs"]).edge_rust, false);
});
test("the Presentation Model selects Studio and production runtime consumers", () => {
  assert.deepEqual(
    selected(["packages/presentation-model/src/availability.ts"]),
    [
      "browser_player",
      "container",
      "dashboard",
      "e2e",
      "edge_conformance",
      "edge_runtime",
      "edge_wpe",
      "linux",
      "runtime",
      "windows",
    ],
  );
  assert.deepEqual(selected(["packages/presentation-model/package.json"]), [
    "browser_player",
    "container",
    "dashboard",
    "e2e",
    "edge_conformance",
    "edge_runtime",
    "edge_wpe",
    "linux",
    "runtime",
    "windows",
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
test("the package guest SDK and samples ride the package lanes", () => {
  for (const path of [
    "packages/package-guest-sdk/Cargo.toml",
    "packages/package-guest-sdk/src/lib.rs",
    "packages/package-samples/hello-services/tilecast.package.json",
    "packages/package-samples/hello-services/guest/src/lib.rs",
    "packages/package-samples/hello-services/runtime/hello_services.wasm",
  ]) {
    const result = affected([path]);
    for (const area of ["plugins", "server", "container", "e2e"])
      assert.equal(result[area], true, `${path}: ${area}`);
    assert.equal(result.player_core, false, path);
    assert.equal(result.ios, false, path);
  }
  assert.deepEqual(
    selected(["packages/package-samples/hello-services/README.md"]),
    ["docs"],
  );
});
test("external Widget fixture changes reach every host and shared SDK", () => {
  for (const path of [
    "packages/player-contracts/fixtures/widget-package/bundle.js",
    "packages/player-contracts/fixtures/widget-package/hostile.js",
  ]) {
    const result = affected([path]);
    for (const area of [
      "widgets",
      "server",
      "dashboard",
      "runtime",
      "browser_player",
      "android",
      "windows",
      "edge_rust",
      "edge_wpe",
      "edge_conformance",
      "player_core",
    ]) {
      assert.equal(result[area], true, `${path}: ${area}`);
    }
  }
});
test("the player capability registry selects its browser, server, and Rust consumers", () => {
  const result = affected([
    "packages/player-contracts/player-capabilities.json",
  ]);
  for (const area of [
    "browser_player",
    "server",
    "player_core",
    "container",
    "e2e",
    "android",
    "windows",
    "edge_rust",
  ])
    assert.equal(result[area], true, area);
  assert.equal(result.ios, false);
  assert.equal(result.docs, false);
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
test("the release version corpus selects every implementation of the ordering", () => {
  const result = affected([
    "packages/player-contracts/fixtures/release-versions.json",
  ]);
  for (const area of ["server", "edge_rust", "windows", "ci"])
    assert.equal(result[area], true, area);
  // The Python implementation feeds the Edge release build.
  assert.equal(
    affected(["scripts/release/release_version.py"]).edge_rust,
    true,
  );
  // Release coordination scripts need only the CI contract lane.
  const scripts = affected(["scripts/release/release_assemble.py"]);
  assert.equal(scripts.ci, true);
  assert.equal(scripts.android, false);
  assert.equal(scripts.server, false);
  // The pipeline test runs the server's importer over signed assets.
  const importer = affected(["apps/server/internal/updates/discovery.go"]);
  assert.equal(importer.server, true);
  assert.equal(importer.ci, true);
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
test("the widget-frames fixture selects the protocol lane and the shared crates", () => {
  const result = affected([
    "packages/player-contracts/fixtures/widget-frames.json",
  ]);
  for (const area of [
    "protocol",
    "player_core",
    "server",
    "android",
    "runtime",
    "windows",
    "linux",
    "edge_rust",
    "edge_server",
    "edge_wpe",
    "edge_conformance",
    "browser_player",
  ])
    assert.equal(result[area], true, area);
  assert.equal(result.ios, false);
  assert.equal(result.docs, false);
});
test("shared schema contracts distinguish players from ordinary API consumers", () => {
  for (const path of [
    "packages/manifest-schema/schema-v16.json",
    "packages/manifest-schema/schedule-fixtures.json",
    "packages/manifest-schema/date-selection-fixtures.json",
    "packages/manifest-schema/data-document-value-fixtures.json",
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
  assert.deepEqual(selected(["packages/api-schema/generated/openapi.d.ts"]), [
    "container",
    "dashboard",
    "e2e",
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
test("graph, workflows and lockfiles still select full validation", () => {
  for (const path of [
    "scripts/ci/affected.mjs",
    ".github/workflows/pr-validation.yml",
    "package-lock.json",
  ])
    assert.deepEqual(selected([path]), [...areas].sort());
});

test("unknown shared package paths fail with an ownership error", () => {
  for (const path of [
    "packages/new-contract/index.ts",
    "packages/api-schema/new-contract.json",
  ])
    assert.throws(
      () => affected([path]),
      /Unowned shared package path: .* Add its consumers to scripts\/ci\/affected\.mjs\./,
      path,
    );
});
test("full run and empty diff", () => {
  assert.deepEqual(
    affected([], { full: true }),
    Object.fromEntries(areas.map((area) => [area, true])),
  );
  assert.deepEqual(selected([]), []);
});
test("Linux release contract is limited to package, update, and CI inputs", () => {
  for (const path of [
    "apps/player-linux/src/core/player.ts",
    "apps/player-linux/src/core/player.test.ts",
    "apps/player-linux/src/main/runtime-messages.ts",
    "apps/player-linux/conformance/runner.cjs",
    "apps/player-linux/README.md",
    "packages/player-runtime/src/engine/player-machine.test.ts",
    "packages/player-runtime/conformance/run.mjs",
  ])
    assert.equal(linuxReleaseContractRequired([path]), false, path);

  for (const path of [
    "apps/player-linux/package.json",
    "apps/player-linux/electron-builder.config.cjs",
    "apps/player-linux/src/assets/loading.png",
    "apps/player-linux/src/core/self-update.ts",
    "apps/player-linux/src/core/autostart.ts",
    "apps/player-linux/src/core/identifiers.ts",
    "packages/player-runtime/src/engine/player-machine.ts",
    "scripts/build-linux-player-release.sh",
    "scripts/verify-linux-player-release.mjs",
    "package-lock.json",
    ".github/workflows/validate-linux.yml",
    "scripts/ci/affected.mjs",
  ])
    assert.equal(linuxReleaseContractRequired([path]), true, path);

  assert.equal(linuxReleaseContractRequired([], { full: true }), true);
  assert.equal(
    linuxReleaseContractRequired(["packages/player-runtime/README.md"]),
    false,
  );
});
test("Linux release selection is exported for the workflow caller", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tilecast-linux-output-"));
  const output = join(cwd, "github-output");
  const run = (path) =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./affected.mjs", import.meta.url)),
        path,
        "--github-output",
      ],
      { env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8" },
    );
  try {
    run("apps/player-linux/src/core/player.ts");
    assert.match(
      readFileSync(output, "utf8"),
      /linux_release_contract=false\n/,
    );
    writeFileSync(output, "");
    run("apps/player-linux/package.json");
    assert.match(readFileSync(output, "utf8"), /linux_release_contract=true\n/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

test("Browser Player has its own lane and follows the Runtime and the server code it uses", () => {
  assert.ok(areas.includes("browser_player"));
  assert.deepEqual(selected(["apps/player-web/src/application.ts"]), [
    "browser_player",
  ]);
  // The Companion extension rides the Browser Player lane.
  for (const path of [
    "apps/browser-companion/src/background.ts",
    "packages/companion-protocol/src/protocol.ts",
  ]) {
    assert.deepEqual(selected([path]), ["browser_player"], path);
  }
  for (const path of [
    "apps/server/internal/web/player.go",
    "apps/server/internal/httpapi/browser_player.go",
    "apps/server/internal/devices/browser_sessions.go",
  ]) {
    const result = selected([path]);
    assert.ok(result.includes("browser_player"), path);
    assert.ok(result.includes("server"), path);
  }
  // The Runtime is bundled into the Browser Player, unchanged.
  assert.ok(
    selected([
      "packages/player-runtime/src/compat/projection/resolve.ts",
    ]).includes("browser_player"),
  );
  assert.ok(
    selected(["packages/presentation-model/src/availability.ts"]).includes(
      "browser_player",
    ),
  );
  // Studio-only and unrelated Player changes do not run it.
  assert.ok(
    !selected(["apps/dashboard/src/pages/ScreensPage.tsx"]).includes(
      "browser_player",
    ),
  );
  assert.ok(
    !selected(["apps/player-android/app/build.gradle.kts"]).includes(
      "browser_player",
    ),
  );
});

test("shared Player policy selects its consumers and the cross-player pin", () => {
  for (const path of [
    "packages/player-activity/src/sessions.ts",
    "packages/player-activity/package.json",
  ]) {
    const result = affected([path]);
    for (const area of ["linux", "browser_player", "edge_activity"])
      assert.equal(result[area], true, `${path} ${area}`);
    assert.equal(result.android, false, path);
  }
  const hours = affected(["packages/player-active-hours/src/active-hours.ts"]);
  assert.equal(hours.linux, true);
  assert.equal(hours.browser_player, true);
  assert.equal(hours.edge_activity, false);
  const fixture = affected([
    "packages/settings-schema/active-hours-fixtures.json",
  ]);
  for (const area of ["player_core", "linux", "browser_player"])
    assert.equal(fixture[area], true, area);
});

test("the Browser capability matrix selects every generated consumer", () => {
  for (const path of [
    "apps/player-web/capabilities.json",
    "scripts/generate-browser-capabilities.mjs",
  ]) {
    const result = affected([path]);
    for (const area of ["browser_player", "server", "dashboard", "docs", "ci"])
      assert.equal(result[area], true, `${path} ${area}`);
  }
});
