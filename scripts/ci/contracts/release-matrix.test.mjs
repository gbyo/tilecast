import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = (file) =>
  parse(readFileSync(`.github/workflows/${file}`, "utf8"), {
    uniqueKeys: true,
  });

// The architectures a build job covers, and the runner each one gets. The
// matrix is the JSON list the coordinated release passes in, so a resumed
// release builds only the architectures still missing; the runner follows
// from the architecture.
const architectures = (release) => {
  const match = /fromJSON\(inputs\.arches \|\| '(\[.*\])'\)/.exec(
    release.jobs.release.strategy.matrix.arch,
  );
  assert.ok(match, "the matrix reads inputs.arches with a default");
  return JSON.parse(match[1]);
};
const runnerFor = (release, arch) => {
  const match =
    /^\$\{\{ matrix\.arch == '(\w+)' && '([^']+)' \|\| '([^']+)' \}\}$/.exec(
      release.jobs.release["runs-on"],
    );
  assert.ok(match, "runs-on chooses by architecture");
  return arch === match[1] ? match[2] : match[3];
};

test("Edge releases build natively per architecture", () => {
  const release = workflow("edge-release.yml");
  assert.deepEqual(architectures(release).sort(), ["aarch64", "x86_64"]);
  // Native builds on native runners; emulation is never ARM64 support.
  assert.equal(runnerFor(release, "x86_64"), "ubuntu-latest");
  assert.equal(runnerFor(release, "aarch64"), "ubuntu-24.04-arm");

  const raw = readFileSync(".github/workflows/edge-release.yml", "utf8");
  // A WPE build for the other architecture must never be restored into
  // this build.
  assert.match(raw, /key: edge-wpe-\$\{\{ matrix\.arch \}\}-/);
  // Per-architecture artifacts, SBOMs and provenance attestations.
  assert.match(raw, /name: tilecast-edge-release-\$\{\{ matrix\.arch \}\}/);
});

test("Edge releases get WebKit from GHCR, then the cache, then a compile", () => {
  const release = workflow("edge-release.yml");
  const steps = release.jobs.release.steps;
  const index = (predicate) => steps.findIndex(predicate);
  const login = index((step) => step.uses === "docker/login-action@v4");
  const fetch = index((step) => step.id === "wpe");
  const cache = index((step) => step.uses === "actions/cache@v6");
  const build = index((step) => step.name === "Build, sign and package");
  assert.ok(login >= 0 && fetch > login && cache > fetch && build > cache);
  // The registry tier never fails the release: a missing or rejected
  // prebuild falls through to the cache and then to the compile.
  assert.match(
    steps[fetch].run,
    /if apps\/edge\/release\/fetch-wpe-prebuild\.sh/,
  );
  assert.match(
    steps[fetch].run,
    /falling back to the CI cache or a from-scratch compile/,
  );
  assert.equal(release.jobs.release.permissions.packages, "read");
  // The build restores the tar when one is present and compiles otherwise.
  const build_script = readFileSync(
    "apps/edge/release/build-edge-release.sh",
    "utf8",
  );
  assert.match(
    build_script,
    /if \[ -f "\$cache" \]; then\n\s+tar -xf "\$cache" -C \//,
  );
  assert.match(
    build_script,
    /else\n\s+"\$release\/build-wpe\.sh" \/ \/cache\/wpe-work/,
  );
  // Nothing in the release workflows reads the old release URLs.
  assert.doesNotMatch(steps[fetch].run, /gh release download/);
});

test("the WPE prebuild publishes to GHCR and never creates a GitHub release", () => {
  const raw = readFileSync(".github/workflows/wpe-prebuild.yml", "utf8");
  const prebuild = workflow("wpe-prebuild.yml");
  assert.doesNotMatch(raw, /gh release/);
  assert.deepEqual(prebuild.jobs.prebuild.permissions, {
    contents: "read",
    packages: "write",
    "id-token": "write",
    attestations: "write",
  });
  const publish = prebuild.jobs.prebuild.steps.find(
    (step) => step.id === "publish",
  );
  assert.match(publish.run, /publish-wpe-prebuild\.sh/);
  // The tar is attested before it is published, and skipped when the
  // immutable tag already exists.
  const attest = prebuild.jobs.prebuild.steps.findIndex(
    (step) => step.uses === "actions/attest-build-provenance@v4",
  );
  const published = prebuild.jobs.prebuild.steps.findIndex(
    (step) => step.id === "publish",
  );
  assert.ok(attest >= 0 && attest < published);
  for (const step of prebuild.jobs.prebuild.steps.filter(
    (step) => step.id === "publish",
  )) {
    assert.match(step.if, /published != 'true'/);
  }
  // The cleanup of the old releases is a separate, guarded workflow.
  const cleanup = workflow("wpe-release-cleanup.yml");
  assert.equal(cleanup.on.workflow_dispatch.inputs.dry_run.default, true);
  const deleting = cleanup.jobs.cleanup.steps.find((step) =>
    step.run?.includes("gh release delete"),
  );
  assert.match(deleting.run, /\$DRY_RUN" != true/);
  assert.match(deleting.run, /\$CONFIRM" = delete-wpe-releases/);
  assert.match(deleting.run, /migrate-wpe-prebuild\.sh check/);
  assert.equal(
    workflow("wpe-backfill.yml").on.workflow_dispatch.inputs.dry_run.default,
    true,
  );
  assert.deepEqual(workflow("wpe-backfill.yml").permissions, {
    contents: "read",
  });
});

test("Windows releases ship x64 and ARM64 together", () => {
  const release = workflow("windows-player-release.yml");
  assert.deepEqual(architectures(release).sort(), ["aarch64", "x86_64"]);
  assert.equal(runnerFor(release, "x86_64"), "windows-latest");
  assert.equal(runnerFor(release, "aarch64"), "windows-11-arm");

  const raw = readFileSync(
    ".github/workflows/windows-player-release.yml",
    "utf8",
  );
  assert.match(raw, /name: tilecast-windows-release-\$\{\{ matrix\.arch \}\}/);
  // Official release builds fail closed without signing material.
  assert.match(raw, /TILECAST_UPDATE_MANIFEST_PRIVATE_KEY_PEM/);
  assert.match(raw, /TILECAST_MSIX_PFX_BASE64/);
  assert.match(raw, /TILECAST_MSIX_PFX_PASSWORD/);
  assert.match(raw, /TILECAST_MSIX_PUBLISHER/);
  // The Rust target follows the architecture too.
  assert.match(
    raw,
    /RUST_TARGET: \$\{\{ matrix\.arch == 'aarch64' && 'aarch64-pc-windows-msvc' \|\| 'x86_64-pc-windows-msvc' \}\}/,
  );
});

test("the release contract names the same platforms the build workflows produce", () => {
  const contract = JSON.parse(
    readFileSync("scripts/release/contract.json", "utf8"),
  );
  const players = contract.components.filter((c) => c.kind === "player");
  const key = (c) => `${c.family}/${c.architecture}`;
  assert.deepEqual(players.map(key).sort(), [
    "android/",
    "edge/aarch64",
    "edge/x86_64",
    "windows/aarch64",
    "windows/x86_64",
  ]);
  // Every contract component has a build job behind it, and its asset names
  // follow the artifact names the build scripts write.
  for (const c of players) {
    const download = c.assets.find((a) => a.role === "download").name;
    const update = c.assets.find((a) => a.role === "update").name;
    if (c.family === "edge") {
      assert.equal(
        download,
        `tilecast-edge-{version}-${c.architecture}.tar.zst`,
      );
      assert.equal(update, `tilecast-edge-update-${c.architecture}.json`);
    } else if (c.family === "windows") {
      assert.equal(
        download,
        `tilecast-windows-{version}-${c.architecture}.msix`,
      );
      assert.equal(update, `tilecast-windows-update-${c.architecture}.json`);
    } else {
      assert.equal(download, "tilecast-player.apk");
      assert.equal(update, "tilecast-player-update.json");
    }
    assert.ok(c.assets.some((a) => a.name === `${update}.sig`));
  }
  // Stable requires every platform; Beta may omit Windows, but never Edge,
  // Android or the Server.
  const required = (channel) =>
    contract.components
      .filter((c) => c.required.includes(channel))
      .map((c) => c.id)
      .sort();
  assert.deepEqual(required("stable"), [
    "android",
    "edge-aarch64",
    "edge-x86_64",
    "server",
    "windows-aarch64",
    "windows-x86_64",
  ]);
  assert.deepEqual(required("beta"), [
    "android",
    "edge-aarch64",
    "edge-x86_64",
    "server",
  ]);
});

test("release artifacts stay architecture-addressed end to end", () => {
  for (const [script, prefix] of [
    ["apps/edge/release/build-edge-release.sh", "tilecast-edge"],
    [
      "apps/player-windows/release/stage-windows-release.py",
      "tilecast-windows",
    ],
  ]) {
    const raw = readFileSync(script, "utf8");
    assert.match(
      raw,
      new RegExp(`tilecast-(edge|windows)-.*arch.*(tar\\.zst|msix)`),
      `${script}: the artifact name carries the architecture`,
    );
    assert.match(
      raw,
      new RegExp(`${prefix}-update-.*arch.*\\.json`),
      `${script}: the update envelope carries the architecture`,
    );
  }
});
