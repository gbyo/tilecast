import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  renameSync,
  readFileSync,
  rmSync,
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
  const steps = workflow.jobs.validate.steps;
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
