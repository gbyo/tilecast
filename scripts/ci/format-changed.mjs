import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function changedFiles(baseSha, cwd = process.cwd()) {
  const output = execFileSync(
    "git",
    [
      "diff",
      "--find-renames",
      "--name-only",
      "-z",
      "--diff-filter=ACMR",
      baseSha,
      "HEAD",
      "--",
    ],
    { cwd, encoding: "utf8" },
  );
  return output.split("\0").filter(Boolean);
}

export function main() {
  const baseSha = process.env.FORMAT_BASE_SHA;
  if (!baseSha) {
    throw new Error(
      "FORMAT_BASE_SHA must identify the pull request base commit",
    );
  }

  const files = changedFiles(baseSha);
  if (files.length === 0) {
    console.log("No changed files to format-check.");
    return;
  }

  execFileSync(
    "npx",
    [
      "prettier",
      "--check",
      "--ignore-unknown",
      "--",
      ...files.map((file) => `./${file}`),
    ],
    { stdio: "inherit" },
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
