// Keeps Browser Player a host, not a second Player Core or renderer.
//
// The Browser Host owns authentication, browser lifecycle, storage, network
// reconciliation and capability reporting. Presentation decisions belong to the
// shared resolver in packages/player-runtime, and what is drawn belongs to the
// one production Runtime. These checks fail when that boundary erodes.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const sources = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ["node_modules", "dist", "e2e", "test-support"].includes(
        entry.name,
      )
        ? []
        : sources(path);
    return /\.(?:ts|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
const text = (path) => readFileSync(path, "utf8");
const host = sources("apps/player-web/src");

test("Browser Host makes no presentation decision of its own", () => {
  assert.ok(host.length > 5);
  const forbidden = [
    // A presentation document is built only by the shared resolver.
    [
      /state:\s*["'](?:playing|idle|unavailable|disabled|sleep)["']/,
      "presentation state",
    ],
    [/No content assigned|Content unavailable|Screen disabled/, "status copy"],
    // Looking content up in the manifest is resolution, not hosting.
    [
      /\.(?:playlists?|layouts?|widgets|websites|schedules|presentationOverride|takeover)\b/,
      "manifest content access",
    ],
    [
      /\b(?:resolveSelection|evaluateSchedule|activeHours|nextTransition(?!At))\b/,
      "schedule evaluation",
    ],
  ];
  for (const path of host)
    for (const [pattern, name] of forbidden)
      assert.doesNotMatch(
        text(path),
        pattern,
        `${path}: ${name} belongs in shared resolution`,
      );
});

test("Browser Host imports only the shared resolver surface from the projection entry", () => {
  const allowed = new Set([
    "layoutIdFromItemId",
    "planPresentation",
    "realizePresentation",
    "statusSurface",
  ]);
  for (const path of host) {
    for (const match of text(path).matchAll(
      /import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']@tilecast\/player-runtime\/projection["']/g,
    )) {
      if (match[1]) continue;
      for (const name of match[2]
        .split(",")
        .map((value) => value.trim().replace(/^type\s+/, ""))
        .filter(Boolean)) {
        if (/^type\s/.test(name)) continue;
        assert.ok(
          allowed.has(name) || /^[A-Z]/.test(name),
          `${path}: ${name} is renderer or presentation code, not host code`,
        );
      }
    }
    assert.doesNotMatch(
      text(path),
      /@tilecast\/player-runtime\/(?:src|dist)\b|player-runtime\/src\//,
      `${path}: use the package's public entry points`,
    );
  }
});

test("Browser Host never claims a native or privileged capability", () => {
  const bridge = text("apps/player-web/src/host.ts");
  assert.match(bridge, /synchronizedPlayback:\s*false/);
  assert.match(bridge, /setup:\s*false/);
  assert.match(bridge, /discovery:\s*false/);
  for (const path of host)
    assert.doesNotMatch(
      text(path),
      /getDisplayMedia|navigator\.usb|navigator\.serial|\blocalStorage\b|\bsessionStorage\b/,
      path,
    );
});

test("Player Runtime and the shared resolver never branch on the host", () => {
  const runtime = sources("packages/player-runtime/src").filter(
    (path) => !path.endsWith("probe.ts"),
  );
  for (const path of runtime)
    assert.doesNotMatch(
      text(path),
      /["']browser["']|host\.info|info\.host|platform\s*===?/,
      `${path}: behavior must follow capabilities, never a host name`,
    );
});

test("Browser is excluded from native update targeting", () => {
  const updates = readFileSync(
    "apps/server/internal/httpapi/updates.go",
    "utf8",
  );
  assert.match(updates, /browser/i);
});
