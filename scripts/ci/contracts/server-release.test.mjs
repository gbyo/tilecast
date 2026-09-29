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
  // A manual dispatch from another branch must not publish either.
  assert.match(String(build.with.push), /refs\/heads\/main/);
  assert.match(tags, /refs\/heads\/main/);
});

test("stable releases publish one image under three aliases", () => {
  const raw = readFileSync(".github/workflows/server-release.yml", "utf8");
  const release = workflow("server-release.yml");

  assert.deepEqual(release.on.push.tags, ["server-v*"]);
  assert.equal(release.concurrency["cancel-in-progress"], false);

  // The release cannot publish without server and container validation.
  assert.deepEqual(release.jobs.release.needs.sort(), [
    "container_ci",
    "server_ci",
  ]);
  assert.equal(
    release.jobs.server_ci.uses,
    "./.github/workflows/ci-server.yml",
  );
  assert.equal(
    release.jobs.container_ci.uses,
    "./.github/workflows/validate-container.yml",
  );

  // Strict server-vX.Y.Z tags only: no beta-style suffix like the player
  // workflows accept, and the tag must agree with the version in source.
  assert.match(raw, /\^server-v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.doesNotMatch(raw, /\(\[\.-\]/);
  assert.match(raw, /internal\/version\/version\.go/);
  assert.match(raw, /does not contain all of main/);
  assert.match(raw, /allow_behind_main/);

  // Stable versions cannot move backwards across published releases.
  assert.match(raw, /gh release list/);
  assert.match(raw, /startswith\("server-v"\)/);

  // One build carries all three aliases with stable build identity and the
  // same provenance/SBOM behavior as development images.
  const meta = release.jobs.release.steps.find((step) => step.id === "meta");
  assert.match(meta.with.tags, /steps\.release\.outputs\.version/);
  assert.match(meta.with.tags, /value=stable/);
  assert.match(meta.with.tags, /value=latest/);
  const build = release.jobs.release.steps.find(
    (step) => step.uses === "docker/build-push-action@v7",
  );
  assert.match(build.with["build-args"], /VERSION_CHANNEL=stable/);
  assert.equal(build.with.provenance, "mode=max");
  assert.equal(build.with.sbom, true);

  // The contract check proves the three tags are the same artifact before
  // the GitHub Release is created with generated notes as the fallback.
  assert.match(raw, /imagetools inspect/);
  assert.match(raw, /generate-notes/);
  assert.match(raw, /gh release create/);
  assert.match(raw, /--verify-tag/);
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
});
