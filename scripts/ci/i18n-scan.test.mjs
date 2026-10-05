import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const oldSource = "export const page = <p>Old untranslated label</p>;\n";

function fixture(t, baselineSource = oldSource) {
  const directory = mkdtempSync(path.join(tmpdir(), "tilecast-i18n-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, "apps/dashboard");
  mkdirSync(path.join(app, "scripts"), { recursive: true });
  mkdirSync(path.join(app, "src"), { recursive: true });
  mkdirSync(path.join(app, "src/data"), { recursive: true });
  copyFileSync(
    path.join(repo, "apps/dashboard/scripts/i18n-scan.mjs"),
    path.join(app, "scripts/i18n-scan.mjs"),
  );
  copyFileSync(
    path.join(repo, "apps/dashboard/scripts/studio-architecture.mjs"),
    path.join(app, "scripts/studio-architecture.mjs"),
  );
  symlinkSync(
    path.join(repo, "node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
  const write = (file, source) => writeFileSync(path.join(app, file), source);
  write("src/Page.tsx", baselineSource);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("add", "apps/dashboard");
  git(
    "-c",
    "user.name=Scanner Test",
    "-c",
    "user.email=scanner@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  );
  const base = git("rev-parse", "HEAD");
  const scan = (...args) =>
    spawnSync(process.execPath, ["scripts/i18n-scan.mjs", ...args], {
      cwd: app,
      encoding: "utf8",
    });
  return { write, scan, base };
}

test("incremental scan ignores historical text after lines move; full scan retains it", (t) => {
  const { write, scan, base } = fixture(t);
  write("src/Page.tsx", `\n\n${oldSource}`);
  const incremental = scan("--check", "--base", base, "src/Page.tsx");
  assert.equal(incremental.status, 0, incremental.stderr);
  assert.match(incremental.stdout, /0 new untranslated strings/);
  const full = scan("--check", "src/Page.tsx");
  assert.equal(full.status, 1);
  assert.match(full.stdout, /Old untranslated label/);
});

test("new and duplicated untranslated occurrences fail without resurfacing baseline text", (t) => {
  const { write, scan, base } = fixture(t);
  write(
    "src/Page.tsx",
    `${oldSource}export const added = <p>New untranslated label</p>;\n`,
  );
  const added = scan("--check", "--base", base, "src/Page.tsx");
  assert.equal(added.status, 1);
  assert.match(added.stdout, /New untranslated label/);
  assert.doesNotMatch(added.stdout, /Old untranslated label/);
  write(
    "src/Page.tsx",
    `${oldSource}export const duplicate = <p>Old untranslated label</p>;\n`,
  );
  const duplicate = scan("--check", "--base", base, "src/Page.tsx");
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stdout, /1 new untranslated string/);
});

test("new files, including paths with spaces, receive a full scan", (t) => {
  const { write, scan, base } = fixture(t);
  write("src/New Page.tsx", "export const page = <p>New file label</p>;\n");
  const result = scan("--check", "--base", base, "src/New Page.tsx");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /New file label/);
});

test("localizing historical text and intentional ignore comments pass", (t) => {
  const { write, scan, base } = fixture(t);
  write(
    "src/Page.tsx",
    'export const page = <p>{t("page.label")}</p>;\n// i18n-ignore\nexport const codeSample = <p>Intentional code sample</p>;\n',
  );
  const result = scan("--check", "--base", base, "src/Page.tsx");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 new untranslated strings/);
});

test("missing or invalid baseline fails clearly instead of silently skipping validation", (t) => {
  const { scan } = fixture(t);
  const missing = scan("--check", "--base");
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--base requires a Git commit or ref/);
  const invalid = scan(
    "--check",
    "--base",
    "missing-comparison-ref",
    "src/Page.tsx",
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /is not a Git commit/);
});

test("architecture mode uses the same baseline comparison for new raw feedback", (t) => {
  const source = "export const page = <Alert>{error.message}</Alert>;\n";
  const { write, scan, base } = fixture(t, source);
  write("src/Page.tsx", `\n${source}`);
  assert.equal(
    scan("--architecture", "--check", "--base", base, "src/Page.tsx").status,
    0,
  );
  write("src/Page.tsx", `${source}toast.add({ title: failure.message });\n`);
  const result = scan(
    "--architecture",
    "--check",
    "--base",
    base,
    "src/Page.tsx",
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /raw-error-feedback/);
  assert.match(result.stdout, /1 new architecture finding/);
});

test("new English mutation feedback fails while translated feedback passes", (t) => {
  const { write, scan, base } = fixture(t);
  write(
    "src/Page.tsx",
    `${oldSource}toast.add({ title: "Changes saved successfully." });\n`,
  );
  const result = scan("--check", "--base", base, "src/Page.tsx");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Changes saved successfully/);
  write(
    "src/Page.tsx",
    `${oldSource}toast.add({ title: t("changes.saved") });\n`,
  );
  assert.equal(scan("--check", "--base", base, "src/Page.tsx").status, 0);
});

test("domain enforcement activates when its query contract is added without reviving historical keys", (t) => {
  const source = 'useQuery({ queryKey: ["screens", "old"] });\n';
  const { write, scan, base } = fixture(t, source);
  write(
    "src/Page.tsx",
    `${source}useQuery({ queryKey: ["screens", "new"] });\n`,
  );
  assert.equal(
    scan("--architecture", "--check", "--base", base, "src/Page.tsx").status,
    0,
  );
  write("src/data/screens.ts", "export const screenKeys = {};\n");
  const result = scan(
    "--architecture",
    "--check",
    "--base",
    base,
    "src/Page.tsx",
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /1 new architecture finding/);
  assert.match(result.stdout, /domain-query-key/);
});
