import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  const tags = image.jobs.build.steps.find((step) => step.id === "meta").with
    .tags;
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
  assert.equal(release.concurrency["cancel-in-progress"], false);
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

  // Build, then release, then promotion: a failed release can never leave
  // the Stable aliases pointing at an unreleased build.
  const index = (predicate) => steps.findIndex(predicate);
  const buildIndex = index(
    (step) => step.uses === "docker/build-push-action@v7",
  );
  const verifyIndex = index(
    (step) =>
      step.run?.includes("Verify the published versioned image") ||
      step.name === "Verify the published versioned image",
  );
  const createIndex = index((step) => step.run?.includes("gh release create"));
  const promoteIndex = index((step) => step.run?.includes("imagetools create"));
  assert.ok(buildIndex >= 0 && createIndex >= 0 && promoteIndex >= 0);
  assert.ok(
    buildIndex < verifyIndex &&
      verifyIndex < createIndex &&
      createIndex < promoteIndex,
    "expected build < verify < gh release create < promotion",
  );

  // Promotion is a registry-native tag operation on the exact versioned
  // digest: no rebuild, and the aliases can only name released artifacts.
  const promote = steps[promoteIndex].run;
  assert.match(promote, /imagetools create/);
  assert.ok(promote.includes('"$image:stable"'));
  assert.ok(promote.includes('"$image:latest"'));
  assert.ok(promote.includes('"$image:$RELEASE_VERSION"'));
  assert.doesNotMatch(promote, /build-push/);
  assert.doesNotMatch(promote, /docker build /);

  // If promotion fails after the release exists, a rerun resumes at
  // promotion instead of rebuilding the released versioned image.
  assert.match(raw, /gh release view/);
  for (const step of [builds[0], steps[verifyIndex], steps[createIndex]]) {
    assert.match(
      String(step.if ?? ""),
      /exists != 'true'/,
      `${step.name ?? step.uses} must skip on a resumed run`,
    );
  }
  assert.ok(!("if" in steps[promoteIndex]));
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
