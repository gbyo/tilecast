import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { affected } from "../affected.mjs";

const workflow = (file) =>
  parse(readFileSync(`.github/workflows/${file}`, "utf8"), {
    uniqueKeys: true,
  });

test("development images never claim a stable alias", () => {
  const raw = readFileSync(".github/workflows/server-image.yml", "utf8");
  const image = workflow("server-image.yml");

  // Tag triggers belong to the release workflow; this one follows main only.
  assert.deepEqual(image.on.push.tags ?? [], []);
  assert.deepEqual(image.on.push.branches, ["main"]);

  const tags = image.jobs.build.steps.find(
    (step) => step.id === "meta",
  ).with.tags;
  assert.match(tags, /value=development/);
  assert.match(tags, /type=sha/);
  assert.doesNotMatch(raw, /value=latest/);
  assert.doesNotMatch(raw, /value=stable/);

  const build = image.jobs.build.steps.find(
    (step) => step.uses === "docker/build-push-action@v7",
  );
  assert.match(build.with["build-args"], /VERSION_CHANNEL=development/);
  // Development images keep the Dockerfile's dev version default.
  assert.doesNotMatch(build.with["build-args"], /VERSION_NUMBER=/);
  // A manual dispatch from another branch must not publish either.
  assert.match(String(build.with.push), /refs\/heads\/main/);
  assert.match(tags, /refs\/heads\/main/);
});

test("unparameterized builds default to development identity", () => {
  const dockerfile = readFileSync("deploy/docker/Dockerfile", "utf8");
  assert.match(dockerfile, /ARG VERSION_NUMBER=\S*-dev/);
  assert.match(dockerfile, /ARG VERSION_CHANNEL=development/);
  assert.match(dockerfile, /-X .*\/version\.Version=\$\{VERSION_NUMBER\}/);
});

test("stable releases trigger from tags only", () => {
  const release = workflow("server-release.yml");
  assert.deepEqual(release.on.push.tags, ["server-v*"]);
  assert.ok(
    !("workflow_dispatch" in release.on),
    "no manual tag input may differ from the validated ref",
  );
});

test("all stable releases serialize through one global group", () => {
  const release = workflow("server-release.yml");
  // A per-tag group would let two different Stable releases race the
  // shared stable/latest aliases, so the group must name no ref or tag.
  assert.equal(release.concurrency.group, "tilecast-server-stable-release");
  assert.doesNotMatch(release.concurrency.group, /github\.ref|tag|version/i);
  assert.equal(release.concurrency["cancel-in-progress"], false);
});

test("release tags must point at a commit on main", () => {
  const raw = readFileSync(".github/workflows/server-release.yml", "utf8");
  // The tag commit must be an ancestor of main: main may advance after
  // tagging. The reverse direction would race normal development.
  assert.ok(
    raw.includes("git merge-base --is-ancestor HEAD refs/remotes/origin/main"),
  );
  assert.ok(
    !raw.includes("git merge-base --is-ancestor refs/remotes/origin/main HEAD"),
  );
});

test("the ancestry predicate accepts main tags and rejects side branches", () => {
  // Behavioral coverage for the predicate in server-release.yml, run
  // against real git histories. The middle case is the regression that
  // the reversed predicate direction failed: main advanced after tagging.
  const makeRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), "server-release-ancestry-"));
    const git = (...args) =>
      execFileSync(
        "git",
        [
          "-c",
          "init.defaultBranch=main",
          "-c",
          "user.email=release@example.test",
          "-c",
          "user.name=Release Test",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: dir, stdio: "pipe" },
      );
    git("init");
    // Distinct messages: identical empty commits made within one second
    // hash to the same object and would collapse the history.
    let sequence = 0;
    const commit = () =>
      git("commit", "--allow-empty", "-m", `change ${sequence++}`);
    commit(); // A
    commit(); // B
    commit(); // C
    return { dir, git, commit };
  };
  const predicateHolds = (dir, ...args) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", ...args], {
        cwd: dir,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  };

  // A---B---C main, tag at C: pass.
  {
    const { dir, git } = makeRepo();
    try {
      git("tag", "server-v0.11.0");
      git("checkout", "--detach", "server-v0.11.0");
      assert.equal(predicateHolds(dir, "HEAD", "main"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Tag at C, then main advances to D: still pass, since the tagged
  // commit remains part of main. The reversed predicate fails here.
  {
    const { dir, git, commit } = makeRepo();
    try {
      git("tag", "server-v0.11.0");
      commit(); // D on main after tagging
      git("checkout", "--detach", "server-v0.11.0");
      assert.equal(predicateHolds(dir, "HEAD", "main"), true);
      assert.equal(predicateHolds(dir, "main", "HEAD"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  //      D tag (unmerged side branch from B)
  //     /
  // A---B---C main: fail.
  {
    const { dir, git, commit } = makeRepo();
    try {
      git("checkout", "-b", "side", "HEAD~1");
      commit(); // D
      git("tag", "server-v0.11.0");
      git("checkout", "--detach", "server-v0.11.0");
      assert.equal(predicateHolds(dir, "HEAD", "main"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("server release notes compare only against the previous server release", () => {
  const raw = readFileSync(".github/workflows/server-release.yml", "utf8");

  assert.ok(raw.includes('previous_tag_name="$previous_tag"'));
  assert.ok(
    raw.includes('test("^server-v[0-9]+\\\\.[0-9]+\\\\.[0-9]+$")'),
  );
  assert.ok(raw.includes('notes="First Stable Tilecast Server release."'));

  const scoped = raw.indexOf('if [ -n "$previous_tag" ]');
  const generated = raw.indexOf("releases/generate-notes");
  const firstRelease = raw.indexOf("First Stable Tilecast Server release.");
  assert.ok(scoped >= 0 && scoped < generated && generated < firstRelease);
});

test("the release caller grants every called validation its permissions", () => {
  const release = workflow("server-release.yml");
  const rank = { read: 1, write: 2 };
  const granted = release.permissions;
  assert.deepEqual(granted, { contents: "read", checks: "write" });

  // The release job overrides with exactly what publishing needs.
  assert.deepEqual(release.jobs.release.permissions, {
    contents: "write",
    packages: "write",
  });

  // A reusable workflow cannot elevate beyond its caller, so every called
  // validation must fit inside the caller grant.
  for (const job of Object.values(release.jobs)) {
    if (!job.uses?.startsWith("./")) continue;
    const called = workflow(job.uses.replace("./.github/workflows/", ""));
    assert.ok(Object.hasOwn(called.on, "workflow_call"), job.uses);
    for (const [scope, level] of Object.entries(called.permissions ?? {})) {
      assert.ok(
        granted[scope] && rank[granted[scope]] >= rank[level],
        `${job.uses} needs ${scope}:${level}, caller grants ${granted[scope] ?? "nothing"}`,
      );
    }
  }
});

test("stable releases gate on the complete server shipping bundle", () => {
  const release = workflow("server-release.yml");
  const gates = {
    server_ci: "./.github/workflows/ci-server.yml",
    dashboard_ci: "./.github/workflows/ci-dashboard.yml",
    container_ci: "./.github/workflows/validate-container.yml",
    browser_ci: "./.github/workflows/validate-browser.yml",
    plugins_ci: "./.github/workflows/validate-plugins.yml",
    widgets_ci: "./.github/workflows/validate-widgets.yml",
    sources_ci: "./.github/workflows/validate-data-sources.yml",
    contracts_ci: "./.github/workflows/validate-cli.yml",
  };
  for (const [job, uses] of Object.entries(gates)) {
    assert.equal(release.jobs[job]?.uses, uses, `${job} must ${uses}`);
  }
  assert.deepEqual(
    [...release.jobs.release.needs].sort(),
    Object.keys(gates).sort(),
  );
  // Separately shipped players must not gate a server release.
  const raw = readFileSync(".github/workflows/server-release.yml", "utf8");
  assert.doesNotMatch(raw, /ci-android|validate-linux|ci-edge|edge-release/);
});

test("the release tag is the authoritative stable version", () => {
  const raw = readFileSync(".github/workflows/server-release.yml", "utf8");
  const release = workflow("server-release.yml");

  // Strict server-vX.Y.Z tags only: no beta-style suffix like the player
  // workflows accept, and no source-version-bump agreement check.
  assert.match(raw, /\^server-v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.doesNotMatch(raw, /\(\[\.-\]/);
  assert.doesNotMatch(raw, /internal\/version\/version\.go/);
  assert.doesNotMatch(raw, /allow_behind_main/);

  // The tag version is injected into the binary at build time.
  const build = release.jobs.release.steps.find(
    (step) => step.uses === "docker/build-push-action@v7",
  );
  assert.match(
    build.with["build-args"],
    /VERSION_NUMBER=\$\{\{ steps\.release\.outputs\.version \}\}/,
  );
  assert.match(build.with["build-args"], /VERSION_CHANNEL=stable/);
});

test("stable aliases move only after the release succeeds", () => {
  const raw = readFileSync(".github/workflows/server-release.yml", "utf8");
  const release = workflow("server-release.yml");
  const steps = release.jobs.release.steps;

  // One build publishes only the immutable versioned tag.
  const builds = steps.filter(
    (step) => step.uses === "docker/build-push-action@v7",
  );
  assert.equal(builds.length, 1);
  const meta = steps.find((step) => step.id === "meta");
  assert.match(meta.with.tags, /steps\.release\.outputs\.version/);
  assert.doesNotMatch(meta.with.tags, /value=stable/);
  assert.doesNotMatch(meta.with.tags, /value=latest/);
  assert.equal(builds[0].with.provenance, "mode=max");
  assert.equal(builds[0].with.sbom, true);

  // Build, verify, release, resolve, promote: a failed release can never
  // leave the Stable aliases pointing at an unreleased build, and no
  // mutable tag resolution sits between verification and promotion.
  const index = (predicate) => steps.findIndex(predicate);
  const buildIndex = index(
    (step) => step.uses === "docker/build-push-action@v7",
  );
  const verifyIndex = index((step) => step.id === "verify");
  const createIndex = index((step) => step.run?.includes("gh release create"));
  const resolveIndex = index((step) => step.id === "promote");
  const promoteIndex = index((step) => step.run?.includes("imagetools create"));
  assert.ok(
    buildIndex >= 0 &&
      verifyIndex >= 0 &&
      createIndex >= 0 &&
      resolveIndex >= 0 &&
      promoteIndex >= 0,
  );
  assert.ok(
    buildIndex < verifyIndex &&
      verifyIndex < createIndex &&
      createIndex < resolveIndex &&
      resolveIndex < promoteIndex,
    "expected build < verify < gh release create < resolve < promotion",
  );

  // The verified digest becomes a step output; promotion consumes the
  // immutable image@digest reference, never the version tag.
  assert.ok(steps[verifyIndex].run.includes('echo "digest=$digest"'));
  const promoteStep = steps[promoteIndex];
  assert.ok(
    String(promoteStep.env?.PROMOTE_DIGEST ?? "").includes(
      "steps.promote.outputs.digest",
    ),
  );
  const promote = promoteStep.run;
  assert.match(promote, /imagetools create/);
  assert.ok(promote.includes('"$image:stable"'));
  assert.ok(promote.includes('"$image:latest"'));
  assert.ok(promote.includes("$image@$PROMOTE_DIGEST"));
  assert.ok(!promote.includes("$image:$RELEASE_VERSION"));
  assert.doesNotMatch(promote, /build-push/);
  assert.doesNotMatch(promote, /docker build /);

  // If promotion fails after the release exists, a rerun resumes at
  // digest resolution instead of rebuilding the released image.
  assert.match(raw, /gh release view/);
  for (const step of [builds[0], steps[verifyIndex], steps[createIndex]]) {
    assert.match(
      String(step.if ?? ""),
      /exists != 'true'/,
      `${step.name ?? step.uses} must skip on a resumed run`,
    );
  }
  assert.ok(!("if" in steps[resolveIndex]));
  assert.ok(!("if" in steps[promoteIndex]));
});

test("a resumed run promotes the digest recorded by the release", () => {
  const release = workflow("server-release.yml");
  const steps = release.jobs.release.steps;
  const resolve = steps.find((step) => step.id === "promote").run;

  // The existing release notes record the digest; the resumed run
  // recovers it, validates its shape, and confirms it still exists.
  assert.ok(resolve.includes("gh release view"));
  assert.ok(resolve.includes("sha256:[0-9a-f]"));
  assert.ok(resolve.includes("imagetools inspect"));
  assert.ok(resolve.includes("$image@$digest"));
  // Fail closed: no valid recorded digest means no promotion, and the
  // version tag is never consulted as a fallback.
  assert.match(resolve, /refusing to guess from the version tag/);
  assert.ok(!resolve.includes("$RELEASE_VERSION"));
});

test("production compose runs a published image selected by TILECAST_VERSION", () => {
  const compose = parse(readFileSync("deploy/docker/compose.yml", "utf8"), {
    uniqueKeys: true,
  });
  const server = compose.services.server;
  assert.match(
    server.image,
    /^ghcr\.io\/gbyo\/tilecast-server:\$\{TILECAST_VERSION/,
  );
  assert.ok(!("build" in server), "production compose must not build source");
  assert.match(server.image, /:-stable\}/);
});

test("development compose keeps a source-build workflow", () => {
  const dev = parse(readFileSync("deploy/docker/compose.dev.yml", "utf8"), {
    uniqueKeys: true,
  });
  assert.equal(
    dev.services.server.build.dockerfile,
    "deploy/docker/Dockerfile",
  );
  assert.ok(dev.services.server.image.includes("tilecast/server:local"));
});

test("the example environment selects the stable channel", () => {
  const env = readFileSync("deploy/docker/.env.example", "utf8");
  assert.match(env, /^TILECAST_VERSION=stable$/m);
});

test("server release files select their validation", () => {
  const selected = (paths) =>
    Object.entries(affected(paths))
      .filter(([, value]) => value)
      .map(([key]) => key)
      .sort();
  assert.ok(selected(["deploy/docker/compose.dev.yml"]).includes("container"));
  assert.ok(
    selected([".github/workflows/server-release.yml"]).includes("server"),
  );
  assert.ok(
    selected([".github/workflows/validate-data-sources.yml"]).includes(
      "sources",
    ),
  );
});
