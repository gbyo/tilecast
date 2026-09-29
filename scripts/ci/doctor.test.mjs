import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const doctor = join(here, "..", "doctor.sh");

function run(area, env = process.env) {
  return execFileSync("sh", [doctor, area], { encoding: "utf8", env });
}

test("doctor shows Android SDK diagnostics only for android and all", () => {
  for (const area of ["android", "all"]) {
    assert.match(run(area), /ANDROID_HOME/, `${area} must report ANDROID_HOME`);
  }
});

test("doctor does not demand unrelated Android toolchain for server/edge/docs", () => {
  for (const area of ["server", "edge", "docs", "dashboard"]) {
    assert.doesNotMatch(
      run(area),
      /ANDROID_HOME/,
      `${area} must not report ANDROID_HOME`,
    );
  }
});

test("doctor asks only Android contributors for Java", () => {
  for (const area of ["server", "edge", "docs", "dashboard", "media"]) {
    assert.doesNotMatch(
      run(area),
      /\bjava\b/i,
      `${area} must not ask for Java`,
    );
  }
  for (const area of ["android", "all"]) {
    assert.match(run(area), /\bjava\b/i, `${area} must report Java`);
  }
});

const root = join(here, "..", "..");
const mise = readFileSync(join(root, "mise.toml"), "utf8");
const pinned = (tool) =>
  new RegExp(`^${tool}\\s*=\\s*"([^"]+)"`, "m").exec(mise)?.[1];

test("mise.toml pins the versions that go.work and CI use", () => {
  const goWork = readFileSync(join(root, "go.work"), "utf8");
  const goVersion = /^go (\d+\.\d+)/m.exec(goWork)?.[1];
  assert.equal(pinned("go"), goVersion, "mise go must match go.work");
  const validation = readFileSync(
    join(root, ".github", "workflows", "pr-validation.yml"),
    "utf8",
  );
  assert.equal(
    pinned("node"),
    /node-version:\s*"?(\d+)"?/.exec(validation)?.[1],
    "mise node must match primary CI",
  );
  const android = readFileSync(
    join(root, ".github", "workflows", "ci-android.yml"),
    "utf8",
  );
  assert.equal(
    pinned("java"),
    /java-version:\s*"?(\d+)"?/.exec(android)?.[1],
    "mise java must match Android CI",
  );
});

test("doctor reports the Java version written to stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "tilecast-doctor-"));
  const java = join(dir, "java");
  writeFileSync(java, "#!/bin/sh\necho 'openjdk version \"21.0.8\"' >&2\n");
  chmodSync(java, 0o755);
  try {
    const out = run("android", {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      ANDROID_HOME: "",
    });
    assert.match(out, /ok\s+java openjdk version "21\.0\.8"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
