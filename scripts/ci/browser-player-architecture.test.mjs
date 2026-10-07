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
// Generated data is checked against its source by `player-contracts:check`.
const hostCode = host.filter((path) => !/\.gen\.ts$/.test(path));
const inside = (path, directory) => path.includes(`/${directory}/`);

test("Browser Host makes no presentation decision of its own", () => {
  assert.ok(hostCode.length > 5);
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
  for (const path of hostCode)
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
  for (const path of hostCode) {
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
  for (const path of hostCode)
    assert.doesNotMatch(
      text(path),
      /getDisplayMedia|navigator\.usb|navigator\.serial|\blocalStorage\b|\bsessionStorage\b|\bdocument\.cookie\b/,
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

test("Browser Host never selects behavior by browser or platform name", () => {
  // Only diagnostics names the browser, and only to report it. The modules
  // that decide behavior must not know what browser they run in.
  const behavior = hostCode.filter((path) =>
    /\/(?:reconcile|host|policy|commands|lifecycle|display|runtime-boot)\.ts$|\/activity\//.test(
      path,
    ),
  );
  assert.ok(behavior.length >= 8);
  for (const path of behavior)
    assert.doesNotMatch(
      text(path),
      /browserName|userAgent|navigator\.platform|\bplatform\s*[=!]==?|["']browser["']\s*[=!]==?|[=!]==?\s*["']browser["']/,
      `${path}: behavior follows capabilities, never a browser or platform name`,
    );
  for (const path of hostCode.filter(
    (value) => !/\/(?:diagnostics|player)\.ts$/.test(value),
  ))
    assert.doesNotMatch(
      text(path),
      /\buserAgent\b|userAgentData/,
      `${path}: only diagnostics reads the user agent`,
    );
});

test("Browser Host ranks no schedule and projects no content", () => {
  for (const path of hostCode) {
    assert.doesNotMatch(
      text(path),
      /\bpriority\b|oneTimeStart|oneTimeEnd|\brecurrence\b|\bweekly\b|\bsortSchedules|\bscheduleRank/,
      `${path}: schedule precedence belongs to the server`,
    );
    assert.doesNotMatch(
      text(path),
      /\b(?:projectManifestItems|createProjector|presentationNeedsProjection|layoutRender|widgetRender)\b/,
      `${path}: content projection belongs to the shared Runtime`,
    );
  }
});

test("Pure shared policy stays in its package, and the Host consumes it", () => {
  const defined =
    /(?:function|class|const)\s+(?:evaluateActiveHours|activeHoursFromConfig|parseClockMinutes|overridesActiveHours|buildOutsideActiveHoursPresentation|PlaybackSessionTracker|buildActivityRecord|applyRendererEvent|presentationContextFor|replacementReasonFor|contentContextFor|stopForState|playbackFailureEvent)\b/;
  for (const path of hostCode)
    assert.doesNotMatch(
      text(path),
      defined,
      `${path}: this policy already has a shared owner`,
    );
  const all = hostCode.map(text).join("\n");
  assert.match(all, /@tilecast\/player-active-hours/);
  assert.match(all, /@tilecast\/player-activity/);
  // The packages never import the Host back.
  for (const directory of ["player-activity", "player-active-hours"])
    for (const path of sources(`packages/${directory}/src`))
      assert.doesNotMatch(
        text(path),
        /player-web|@tilecast\/player-runtime|from\s+["']\.\.\/\.\.\/\.\.\//,
        `${path}: shared policy knows no host`,
      );
});

test("Browser Host keeps credentials and the recovery secret out of storage", () => {
  for (const path of hostCode) {
    if (inside(path, "storage") || /\/identity\.ts$/.test(path))
      assert.doesNotMatch(
        text(path),
        /recovery/i,
        `${path}: the recovery secret is never persisted`,
      );
  }
  // The bootstrap hands the secret over once and keeps no copy.
  assert.doesNotMatch(
    text("apps/player-web/src/bootstrap.ts"),
    /indexedDB|\.put\(|\.setItem\(|caches\./,
  );
  // The secret only ever goes to the recover request, never to a write.
  assert.doesNotMatch(
    text("apps/player-web/src/authentication.ts"),
    /write\([^)]*recovery/,
  );
});

test("Browser Host offers no arbitrary-script or generic command bridge", () => {
  for (const path of hostCode)
    assert.doesNotMatch(
      text(path),
      /\beval\s*\(|new\s+Function\s*\(|\bexecuteJavascript\b|\bbrowserRpc\b|\bbrowserCommand\b|javascript:|importScripts\s*\(\s*[^"')]/,
      `${path}: no generic script or command escape hatch`,
    );
  // Every command is a typed server command type from the generated matrix.
  const matrix = JSON.parse(text("apps/player-web/capabilities.json"));
  const native = [
    /^display_/,
    /^install_/,
    /^power_assist_/,
    /^(?:clear_media_cache|clear_website_data|disable_playback|enable_playback)$/,
    /^(?:restart_player_process|restart_activity|recreate_renderer|recreate_playback_session)$/,
    /^(?:exit_safe_mode|retry_player_recovery|run_player_self_test|resynchronize_player)$/,
    /airplay|presentation_network|autostart/,
  ];
  for (const { type } of matrix.commands.supported)
    for (const pattern of native)
      assert.doesNotMatch(
        type,
        pattern,
        `${type}: a native-only command must not be advertised by Browser Player`,
      );
});

test("Browser Player stays out of native Player release targeting", () => {
  const players = readFileSync("apps/dashboard/src/playerPlatform.ts", "utf8");
  assert.match(players, /platform === "browser"[\s\S]{0,120}return undefined/);
  const hosts = text("apps/player-web/src/heartbeat.ts");
  // It reports its own family, and no native release channel.
  assert.match(hosts, /playerFamily:\s*"browser"/);
  assert.doesNotMatch(hosts, /installerSource|playerVersionCode|updateState/);
});
