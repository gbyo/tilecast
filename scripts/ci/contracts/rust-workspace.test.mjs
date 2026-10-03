import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
