import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  renameSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { test } from "node:test";
import { changedFiles } from "./format-changed.mjs";

test("changed formatting paths include rename destinations and spaces, not deletions", () => {
  const repo = mkdtempSync(join(tmpdir(), "tilecast-format-changed-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

  try {
    git("init", "-q");
    git("config", "user.email", "tilecast-tests@example.invalid");
    git("config", "user.name", "Tilecast tests");
    writeFileSync(join(repo, "old name.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, "deleted.ts"), "export const removed = true;\n");
    writeFileSync(join(repo, "updated.ts"), "export const count = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");

    renameSync(join(repo, "old name.ts"), join(repo, "renamed file.ts"));
    rmSync(join(repo, "deleted.ts"));
    writeFileSync(join(repo, "updated.ts"), "export const count = 2;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "changes");

    assert.deepEqual(changedFiles(baseSha, repo).sort(), [
      "renamed file.ts",
      "updated.ts",
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dashboard PR formatting is scoped while other callers check the whole repository", () => {
  const workflow = parse(
    readFileSync(
      join(process.cwd(), ".github/workflows/ci-dashboard.yml"),
      "utf8",
    ),
  );
  const steps = workflow.jobs.lint.steps;
  const changed = steps.find(
    (step) => step.name === "Check formatting for changed files",
  );
  const full = steps.find(
    (step) => step.name === "Check repository formatting",
  );

  assert.equal(changed.if, "${{ github.event_name == 'pull_request' }}");
  assert.match(changed.run, /git fetch --no-tags --depth=1 origin/);
  assert.match(changed.run, /node scripts\/ci\/format-changed\.mjs/);
  assert.equal(full.if, "${{ github.event_name != 'pull_request' }}");
  assert.equal(full.run, "npm run format:check");
});

test("format check accepts formatted changes and rejects unformatted changes without writing files", () => {
  const repo = mkdtempSync(join(tmpdir(), "tilecast-format-check-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const script = join(process.cwd(), "scripts/ci/format-changed.mjs");

  try {
    git("init", "-q");
    git("config", "user.email", "tilecast-tests@example.invalid");
    git("config", "user.name", "Tilecast tests");
    writeFileSync(join(repo, "value.js"), "export const value = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    symlinkSync(
      join(process.cwd(), "node_modules"),
      join(repo, "node_modules"),
    );
    const check = () =>
      spawnSync(process.execPath, [script], {
        cwd: repo,
        env: { ...process.env, FORMAT_BASE_SHA: baseSha },
        encoding: "utf8",
      });

    const empty = check();
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /No changed files/);

    for (const [source, expectedStatus] of [
      ["export const value = 2;\n", 0],
      ["export const value=3", 1],
    ]) {
      writeFileSync(join(repo, "value.js"), source);
      git("add", "value.js");
      git("commit", "-q", "-m", "change formatting");
      const result = check();
      assert.equal(result.status, expectedStatus, result.stderr);
      assert.equal(readFileSync(join(repo, "value.js"), "utf8"), source);
      assert.equal(git("diff", "--", "value.js"), "");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
