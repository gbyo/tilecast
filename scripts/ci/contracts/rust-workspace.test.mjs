import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const manifest = (path) =>
  JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))",
        path,
      ],
      { encoding: "utf8" },
    ),
  );

test("virtual Rust workspace has one lockfile and independent Edge version", () => {
  const root = manifest("Cargo.toml");
  assert.equal(root.package, undefined);
  assert.equal(root.workspace.package.version, undefined);
  const defaults = root.workspace["default-members"];
  assert.ok(defaults.length > 0);
  assert.ok(defaults.every((path) => path.startsWith("apps/edge/")));
  assert.ok(defaults.every((path) => root.workspace.members.includes(path)));
  assert.equal(root.workspace.package["rust-version"], "1.98");
  assert.throws(() => readFileSync("apps/edge/Cargo.lock"), { code: "ENOENT" });
  assert.throws(() => readFileSync("apps/edge/Cargo.toml"), { code: "ENOENT" });
  assert.ok(readFileSync("Cargo.lock", "utf8").includes("version = 4"));
  assert.match(
    readFileSync("apps/edge/release/VERSION", "utf8"),
    /^\d+\.\d+\.\d+[^\n]*\n$/,
  );
});

test("Edge validation selects all Edge packages explicitly", () => {
  const root = manifest("Cargo.toml");
  const expected = root.workspace.members
    .filter((path) => path.startsWith("apps/edge/"))
    .map((path) => manifest(`${path}/Cargo.toml`).package.name)
    .sort();
  const directory = mkdtempSync(join(tmpdir(), "tilecast-cargo-scope-"));
  try {
    writeFileSync(
      join(directory, "cargo"),
      '#!/bin/sh\nprintf "%s\\n" "$@"\n',
      { mode: 0o755 },
    );
    for (const command of ["fmt", "clippy", "test"]) {
      const args = execFileSync(
        "bash",
        ["apps/edge/ci/cargo-edge.sh", command],
        {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          encoding: "utf8",
        },
      )
        .trim()
        .split("\n");
      assert.equal(args[0], command);
      assert.equal(args.includes("--workspace"), false);
      const packages = args.filter((_, i) => args[i - 1] === "-p").sort();
      assert.deepEqual(packages, expected);
      assert.equal(args.includes("--locked"), command !== "fmt");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Edge CI caches the root lockfile, toolchain, and output directory", () => {
  const ci = parse(readFileSync(".github/workflows/ci-edge.yml", "utf8"));
  const cache = ci.jobs.rust.steps.find((step) =>
    step.uses?.startsWith("actions/cache@"),
  );
  assert.match(
    cache.with.key,
    /hashFiles\('Cargo.lock', 'rust-toolchain.toml'\)/,
  );
  assert.ok(cache.with.path.split("\n").includes("target"));
  const release = readFileSync(
    "apps/edge/release/build-edge-release.sh",
    "utf8",
  );
  assert.match(release, /inputs\.py" version/);
  assert.match(release, /inputs\.py" state-schema/);
  assert.match(
    release,
    /--cargo-artifacts \/cache\/edge-rust-artifacts\.jsonl/,
  );
});

test("shared Player validation runs portable packages on every host OS and CPU", () => {
  const ci = parse(
    readFileSync(".github/workflows/validate-player-core.yml", "utf8"),
  );
  assert.deepEqual(ci.jobs.validate.strategy.matrix.os, [
    "ubuntu-latest",
    "ubuntu-24.04-arm",
    "macos-latest",
    "windows-latest",
    "windows-11-arm",
  ]);
  const commands = ci.jobs.validate.steps.flatMap((step) => step.run ?? []);
  for (const command of [
    "fmt --check",
    "clippy --all-targets --all-features -- -D warnings",
    "test --all-features",
    "doc --no-deps --all-features",
  ]) {
    assert.ok(commands.includes(`bash scripts/ci/cargo-player.sh ${command}`));
  }
  const pr = parse(readFileSync(".github/workflows/pr-validation.yml", "utf8"));
  assert.equal(
    pr.jobs.player_core_ci.uses,
    "./.github/workflows/validate-player-core.yml",
  );
  assert.match(pr.jobs.player_core_ci.if, /needs.changes.outputs.player_core/);
});

test("shared validation selects registered root crates and never Edge packages", () => {
  const root = manifest("Cargo.toml");
  const expected = root.workspace.members
    .filter((path) => path.startsWith("crates/"))
    .map((path) => manifest(`${path}/Cargo.toml`).package.name)
    .sort();
  const metadata = {
    packages: root.workspace.members.map((path) => ({
      name: manifest(`${path}/Cargo.toml`).package.name,
      manifest_path: resolve(path, "Cargo.toml"),
    })),
  };
  const directory = mkdtempSync(join(tmpdir(), "tilecast-player-scope-"));
  try {
    writeFileSync(join(directory, "metadata.json"), JSON.stringify(metadata));
    writeFileSync(
      join(directory, "cargo"),
      '#!/bin/sh\nif [ "$1" = metadata ]; then cat "$PLAYER_SCOPE_METADATA"; else printf "%s\\n" "$@"; fi\n',
      { mode: 0o755 },
    );
    for (const command of ["fmt", "clippy", "test", "doc"]) {
      const args = execFileSync(
        "bash",
        ["scripts/ci/cargo-player.sh", command],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            PLAYER_SCOPE_METADATA: join(directory, "metadata.json"),
          },
          encoding: "utf8",
        },
      )
        .trim()
        .split("\n");
      assert.equal(args[0], command);
      assert.equal(args.includes("--workspace"), false);
      assert.deepEqual(
        args.filter((_, i) => args[i - 1] === "-p").sort(),
        expected,
      );
      assert.equal(args.includes("--locked"), command !== "fmt");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("privileged Edge helpers have no storage, server client, or Core dependency", () => {
  const root = manifest("Cargo.toml");
  const packages = new Map(
    root.workspace.members.map((path) => {
      const data = manifest(`${path}/Cargo.toml`);
      return [data.package.name, { path, data }];
    }),
  );
  const forbidden = new Set([
    "edge-state",
    "edge-cas",
    "edge-server",
    "player-state",
    "player-cas",
    "player-client",
    "player-core",
  ]);
  for (const helper of ["tilecast-edge-migrate", "tilecast-edge-update"]) {
    const seen = new Set();
    const queue = [helper];
    for (const name of queue) {
      assert.equal(forbidden.has(name), false, `${helper} reaches ${name}`);
      if (seen.has(name)) continue;
      seen.add(name);
      const item = packages.get(name);
      if (!item) continue;
      const tables = [item.data, ...Object.values(item.data.target ?? {})];
      for (const table of tables) {
        for (const [alias, original] of Object.entries(
          table.dependencies ?? {},
        )) {
          const dependency = original.workspace
            ? root.workspace.dependencies[alias]
            : original;
          let target = dependency.package ?? alias;
          if (dependency.path) {
            const base = original.workspace ? "." : item.path;
            target = manifest(resolve(base, dependency.path, "Cargo.toml"))
              .package.name;
          }
          if (packages.has(target)) queue.push(target);
        }
      }
    }
  }
});
