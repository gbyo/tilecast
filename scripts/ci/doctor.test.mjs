import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
