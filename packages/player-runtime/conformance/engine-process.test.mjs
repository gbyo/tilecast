import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { electronExecutable, engineFailure } from "./engine-process.mjs";

test("resolves Electron through its package so a fresh install can download the binary", () => {
  const executable = electronExecutable(undefined, (name) => {
    assert.equal(name, "electron");
    return "C:\\Program Files\\Electron\\electron.exe";
  });
  assert.equal(executable, "C:\\Program Files\\Electron\\electron.exe");
});

test("an explicit engine path does not load the installed package", () => {
  assert.equal(
    electronExecutable("/custom/electron", () => {
      assert.fail("an override must not install another Electron");
    }),
    "/custom/electron",
  );
});

test("a missing executable reports the actual process startup error", () => {
  const child = spawnSync(`${process.execPath}.missing-conformance-engine`, []);
  assert.match(engineFailure(child, null), /process startup failed \(ENOENT\)/);
});

test("distinguishes a signal, nonzero exit, missing result and fixture failure", () => {
  assert.equal(
    engineFailure({ signal: "SIGTERM" }, null),
    "process terminated by SIGTERM",
  );
  assert.equal(
    engineFailure({ status: 7 }, null),
    "process exited with code 7",
  );
  assert.equal(engineFailure({ status: 0 }, null), "no result");
  assert.equal(
    engineFailure({ status: 1 }, { failure: "render failed" }),
    "render failed",
  );
  assert.equal(engineFailure({ status: 0 }, {}), null);
});
