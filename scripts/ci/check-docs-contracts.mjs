// Verify a few source-backed engineering documentation invariants.
// This is deliberately narrow: it is not a parser for all historical docs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export function findDocumentationDrift({
  provider,
  gradle,
  updates,
  credentials,
  android,
  architecture,
  core,
  plugins,
  edge,
  websites,
  previews,
}) {
  const errors = [];
  const owner = /GitHubOwner\s*=\s*"([^"]+)"/.exec(provider)?.[1];
  const repo = /GitHubRepo\s*=\s*"([^"]+)"/.exec(provider)?.[1];
  if (!owner || !repo) {
    errors.push("Fixed release owner/repo not found in updates/provider.go");
  } else {
    const docs = [
      ["player-updates.md", updates],
      ["device-credential-security.md", credentials],
    ];
    for (const [file, content] of docs) {
      if (!content.includes(`${owner}/${repo}`)) {
        errors.push(`${file}: fixed release source must be ${owner}/${repo}`);
      }
    }
  }
  if (!/compileSdk\s*=\s*\d+/.test(gradle) || !/minSdk\s*=\s*\d+/.test(gradle)) {
    errors.push("Android compileSdk/minSdk not found in app Gradle");
  }
  if (/Android SDK\s+\d+/.test(android) || !android.includes("app/build.gradle.kts")) {
    errors.push("android-development.md: use app/build.gradle.kts SDK values");
  }
  if (/Android Room stores (pending|active)/.test(architecture)) {
    errors.push("architecture.md: obsolete production Room manifest ownership");
  }
  if (/Production still runs the Kotlin Player|does not build macOS, browser/.test(core)) {
    errors.push("player-core.md: obsolete native or Browser Player status");
  }
  if (/Reserved: (composition|proof-of-play)[^\n]*not started/.test(plugins)) {
    errors.push("plugin-api.md: stale milestone status");
  }
  if (!edge.includes("Historical milestone snapshot")) {
    errors.push("tilecast-edge-next.md: missing historical status label");
  }
  if (!websites.includes("Layout zone")) {
    errors.push("website-content.md: document Website playback inside Layouts");
  }
  if (!previews.includes("Linux Edge") || !previews.includes("Linux Legacy")) {
    errors.push("live-previews.md: separate Edge and Legacy capture");
  }
  return errors;
}

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === filename) {
  const root = resolve(dirname(filename), "../..");
  const read = (path) => readFileSync(join(root, path), "utf8");
  const errors = findDocumentationDrift({
    provider: read("apps/server/internal/updates/provider.go"),
    gradle: read("apps/player-android/app/build.gradle.kts"),
    updates: read("docs/player-updates.md"),
    credentials: read("docs/device-credential-security.md"),
    android: read("docs/android-development.md"),
    architecture: read("docs/architecture.md"),
    core: read("docs/player-core.md"),
    plugins: read("docs/plugin-api.md"),
    edge: read("docs/tilecast-edge-next.md"),
    websites: read("docs/website-content.md"),
    previews: read("docs/live-previews.md"),
  });
  if (errors.length) {
    errors.forEach((error) => console.error("docs-contract: " + error));
    process.exitCode = 1;
  } else {
    console.log("docs-contract: source-backed documentation checks passed");
  }
}
