import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const doctor = join(here, "..", "doctor.sh");

function run(area) {
  return execFileSync("sh", [doctor, area], { encoding: "utf8" });
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
