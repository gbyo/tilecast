import assert from "node:assert/strict";
import { test } from "node:test";
import { findDocumentationDrift } from "./check-docs-contracts.mjs";

const good = {
  provider: 'const (\n GitHubOwner = "gbyo"\n GitHubRepo = "tilecast"\n)',
  gradle: "compileSdk = 37\nminSdk = 23",
  updates: "Fixed release source: gbyo/tilecast",
  credentials: "Releases come only from gbyo/tilecast",
  android: "SDKs are pinned in app/build.gradle.kts",
  architecture: "Core stores verified active manifests",
  core: "Android production uses native Core; Browser Player is experimental",
  plugins: "Stages 8 and 9 are historical, shipped under other contracts",
  edge: "Historical milestone snapshot; see per-device evidence",
  websites: "Website content plays inside a Layout zone",
  previews: "Linux Edge and Linux Legacy have separate capture paths",
};

test("accepts the current source-backed documentation facts", () => {
  assert.deepEqual(findDocumentationDrift(good), []);
});

test("reports mismatched release repository in both references", () => {
  const errors = findDocumentationDrift({
    ...good,
    provider: good.provider.replace("gbyo", "example"),
  });
  assert.equal(
    errors.filter((error) => error.includes("source must be")).length,
    2,
  );
});

test("flags obsolete Android guidance without lowering minSdk", () => {
  const errors = findDocumentationDrift({
    ...good,
    android: "Install Android SDK 35",
    architecture: "Android Room stores active manifests.",
    core: "Production still runs the Kotlin Player.",
  });
  assert.ok(errors.some((error) => error.includes("android-development.md")));
  assert.ok(errors.some((error) => error.includes("architecture.md")));
  assert.ok(errors.some((error) => error.includes("player-core.md")));
});

test("flags stale feature and release-readiness guidance", () => {
  const errors = findDocumentationDrift({
    ...good,
    plugins: "Reserved: proof-of-play; not started",
    edge: "M12 production rollout has not started",
    websites: "Fullscreen only",
    previews: "Electron screenshot capture",
  });
  assert.equal(errors.length, 4);
});
