import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const base = process.env.TILECAST_DEV_BASE ?? "origin/main";

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function nulPaths(output) {
  return output.split("\0").filter(Boolean);
}

const baseCommit = git(["merge-base", base, "HEAD"]).trim();
const changed = new Set([
  ...nulPaths(git(["diff", "--name-only", "-z", `${baseCommit}...HEAD`])),
  ...nulPaths(git(["diff", "--name-only", "-z"])),
  ...nulPaths(git(["diff", "--cached", "--name-only", "-z"])),
  ...nulPaths(git(["ls-files", "--others", "--exclude-standard", "-z"])),
]);
const paths = [...changed].sort();
if (paths.length === 0) {
  console.log(`No changed files relative to ${base} or the working tree.`);
  process.exit(0);
}

const tasks = [];
function addTask(name, command, args, cwd = root) {
  tasks.push({ name, command, args, cwd });
}

if (
  paths.some(
    (file) =>
      file.startsWith("apps/dashboard/") ||
      /^plugins\/[^/]+\/studio\//.test(file),
  )
) {
  addTask("Studio tests affected by changes", "npm", [
    "run",
    "test",
    "--workspace",
    "@tilecast/dashboard",
    "--",
    `--changed=${base}`,
  ]);
}

if (paths.some((file) => file.startsWith("apps/player-linux/"))) {
  addTask("Linux Player tests affected by changes", "npm", [
    "run",
    "test",
    "--workspace",
    "@gibsonmb71/tilecast-player-linux",
    "--",
    `--changed=${base}`,
  ]);
}

if (paths.some((file) => file.startsWith("packages/player-runtime/"))) {
  addTask("Player Runtime tests affected by changes", "npm", [
    "run",
    "test",
    "--workspace",
    "@tilecast/player-runtime",
    "--",
    `--changed=${base}`,
  ]);
}

const goModules = [
  "apps/server",
  "apps/cli",
  "plugins",
  "packages/plugin-sdk/go",
  "packages/api-client",
  "widgets",
  "data-sources",
];
const goPackages = new Map(goModules.map((module) => [module, new Set()]));
for (const file of paths) {
  if (!file.endsWith(".go")) continue;
  const module = goModules.find((candidate) =>
    file.startsWith(`${candidate}/`),
  );
  if (!module) continue;
  const packageDir = path.posix.dirname(path.posix.relative(module, file));
  goPackages.get(module).add(packageDir === "." ? "." : `./${packageDir}`);
}
for (const file of paths) {
  if (
    file.startsWith("apps/server/internal/database/migrations/") &&
    file.endsWith(".sql")
  ) {
    goPackages.get("apps/server").add("./internal/database");
  }
}
for (const [module, packages] of goPackages) {
  if (packages.size > 0) {
    addTask(
      `Go tests for ${module}`,
      "go",
      ["test", ...[...packages].sort()],
      path.join(root, module),
    );
  }
}

if (paths.some((file) => file.startsWith("plugins/"))) {
  addTask("Plugin manifests and boundaries", "npm", ["run", "plugins:check"]);
}
if (paths.some((file) => file.startsWith("widgets/"))) {
  addTask("Widget SDK and kit checks", "npm", ["run", "widgets:check"]);
}
if (paths.some((file) => file.startsWith("data-sources/"))) {
  addTask("Data source SDK checks", "npm", ["run", "data-sources:check"]);
}
if (
  paths.some(
    (file) =>
      file.startsWith(".github/workflows/") || file.startsWith("scripts/ci/"),
  )
) {
  addTask("CI workflow contracts", "npm", ["run", "test:ci"]);
}
if (paths.some((file) => file.startsWith("apps/player-android/"))) {
  addTask(
    "Android unit tests",
    "./gradlew",
    ["testDebugUnitTest"],
    path.join(root, "apps/player-android"),
  );
}

if (paths.includes(".air.toml")) {
  addTask("Validate Go watcher configuration", "go", [
    "run",
    "github.com/air-verse/air@v1.67.3",
    "-c",
    ".air.toml",
    "-v",
  ]);
}
if (paths.includes("deploy/docker/compose.local-dev.yml")) {
  addTask("Validate local development Compose file", "docker", [
    "compose",
    "-f",
    "deploy/docker/compose.local-dev.yml",
    "config",
    "--quiet",
  ]);
}
if (paths.includes("Makefile")) {
  addTask("Validate development Make targets", "make", [
    "--dry-run",
    "dev",
    "dev-down",
    "dev-server-watch",
    "quick",
    "watch-dashboard",
    "watch-linux",
  ]);
}
for (const file of ["scripts/dev.mjs", "scripts/quick-tests.mjs"]) {
  if (paths.includes(file))
    addTask(`Check ${file} syntax`, "node", ["--check", file]);
}

const documentationChanged = paths.some(
  (file) =>
    file.startsWith("docs/") || file.startsWith("apps/docs/src/content/docs/"),
);
if (documentationChanged) {
  addTask("Engineering documentation rules", "make", ["docs-check"]);
  if (paths.some((file) => file.startsWith("apps/docs/src/content/docs/"))) {
    addTask("Public documentation build and links", "npm", [
      "run",
      "docs:build",
    ]);
  }
}

const handledPrefixes = [
  "apps/dashboard/",
  "apps/player-linux/",
  "packages/player-runtime/",
  "apps/server/",
  "apps/cli/",
  "plugins/",
  "packages/plugin-sdk/go/",
  "packages/api-client/",
  "widgets/",
  "data-sources/",
  ".github/workflows/",
  "scripts/ci/",
  "apps/player-android/",
  "docs/",
  "apps/docs/src/content/docs/",
];
const unclassified = paths.filter(
  (file) =>
    !handledPrefixes.some((prefix) => file.startsWith(prefix)) &&
    ![
      ".air.toml",
      ".gitignore",
      "Makefile",
      "deploy/docker/compose.local-dev.yml",
    ].includes(file) &&
    !["scripts/dev.mjs", "scripts/quick-tests.mjs"].includes(file),
);
if (tasks.length === 0) {
  console.log(
    `No fast test target is mapped for ${paths.length} changed file(s).`,
  );
  process.exit(0);
}

console.log(
  `Running ${tasks.length} focused validation task(s) for ${paths.length} changed file(s), based on ${base}.`,
);
if (unclassified.length > 0) {
  console.log("Unclassified paths still need the full check suite:");
  for (const file of unclassified) console.log(`  ${file}`);
}

for (const task of tasks) {
  console.log(`\n→ ${task.name}`);
  const result = spawnSync(task.command, task.args, {
    cwd: task.cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Focused validation passed. Run `make check` before handoff.");
