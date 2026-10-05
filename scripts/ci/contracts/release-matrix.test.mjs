import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = (file) =>
  parse(readFileSync(`.github/workflows/${file}`, "utf8"), {
    uniqueKeys: true,
  });

const matrix = (release) => release.jobs.release.strategy.matrix.include;

test("Edge releases build natively per architecture", () => {
  const arches = Object.fromEntries(
    matrix(workflow("edge-release.yml")).map((entry) => [
      entry.arch,
      entry.runner,
    ]),
  );
  assert.deepEqual(Object.keys(arches).sort(), ["aarch64", "x86_64"]);
  // Native builds on native runners; emulation is never ARM64 support.
  assert.equal(arches.x86_64, "ubuntu-latest");
  assert.equal(arches.aarch64, "ubuntu-24.04-arm");

  const raw = readFileSync(".github/workflows/edge-release.yml", "utf8");
  // A WPE build for the other architecture must never be restored into
  // this build.
  assert.match(raw, /key: edge-wpe-\$\{\{ matrix\.arch \}\}-/);
  // Per-architecture artifacts, SBOMs and provenance attestations.
  assert.match(raw, /name: tilecast-edge-release-\$\{\{ matrix\.arch \}\}/);
});

test("Windows releases ship x64 and ARM64 together", () => {
  const arches = Object.fromEntries(
    matrix(workflow("windows-player-release.yml")).map((entry) => [
      entry.arch,
      entry.runner,
    ]),
  );
  assert.deepEqual(Object.keys(arches).sort(), ["aarch64", "x86_64"]);
  assert.equal(arches.x86_64, "windows-latest");
  assert.equal(arches.aarch64, "windows-11-arm");

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
