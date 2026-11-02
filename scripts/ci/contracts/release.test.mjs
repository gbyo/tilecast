import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { affected } from "../affected.mjs";

const workflow = (file) =>
  parse(readFileSync(`.github/workflows/${file}`, "utf8"), {
    uniqueKeys: true,
  });

test("development images never claim a release alias", () => {
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
  // Beta is a release channel: only a verified, published release moves it.
  assert.doesNotMatch(raw, /value=beta/);

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

const releaseTriggerTags = (file) => workflow(file).on?.push?.tags ?? [];

test("a coordinated release is a manual dispatch, never a tag push", () => {
  const release = workflow("release.yml");
  assert.deepEqual(Object.keys(release.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(release.on.workflow_dispatch.inputs).sort(), [
    "publish",
    "reuse_unchanged",
    "verify_reproducible",
    "version",
  ]);
  // No other workflow may publish a release from a tag: separate release
  // trains were exactly what the coordinated release replaces. The legacy
  // Electron Linux Player keeps its own tag workflow for its historical line.
  for (const file of readdirSync(".github/workflows")) {
    if (!file.endsWith(".yml")) continue;
    const tags = releaseTriggerTags(file);
    if (file === "linux-player-release.yml") {
      assert.deepEqual(tags, ["player-linux-v*"]);
      continue;
    }
    assert.deepEqual(tags, [], `${file} must not start a release from a tag`);
  }
});

test("all releases serialize through one global group", () => {
  const release = workflow("release.yml");
  // A per-version group would let two releases race the shared aliases or
  // publish out of order, so the group names no ref, tag, or version.
  assert.equal(release.concurrency.group, "tilecast-release");
  assert.doesNotMatch(release.concurrency.group, /github\.ref|tag|version/i);
  assert.equal(release.concurrency["cancel-in-progress"], false);
});

test("the release commit must be part of main", () => {
  const raw = readFileSync(".github/workflows/release.yml", "utf8");
  // The release commit must be an ancestor of main: main may advance while a
  // release builds. The reverse direction would race normal development.
  assert.ok(
    raw.includes("git merge-base --is-ancestor HEAD refs/remotes/origin/main"),
  );
  assert.ok(
    !raw.includes("git merge-base --is-ancestor refs/remotes/origin/main HEAD"),
  );
});

test("the ancestry predicate accepts main tags and rejects side branches", () => {
  // Behavioral coverage for the predicate in release.yml, run
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
      git("tag", "v0.26.0");
      git("checkout", "--detach", "v0.26.0");
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
      git("tag", "v0.26.0");
      commit(); // D on main after tagging
      git("checkout", "--detach", "v0.26.0");
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
      git("tag", "v0.26.0");
      git("checkout", "--detach", "v0.26.0");
      assert.equal(predicateHolds(dir, "HEAD", "main"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("only coordinated tags can be released, in the order the planner allows", () => {
  const release = workflow("release.yml");
  const prepare = release.jobs.prepare.steps;
  const version = prepare.find((step) => step.id === "version");
  assert.match(version.run, /release_version\.py tag "v\$RELEASE_VERSION"/);
  const plan = prepare.find((step) => step.id === "plan");
  assert.match(plan.run, /release_plan\.py --tag "\$TAG"/);
  assert.match(plan.run, /gh release list --limit 1000/);
  // Publication checks the ordering again against the releases as they are
  // then, so a release that finished meanwhile cannot be followed by an
  // older one.
  const publish = release.jobs.publish.steps.find(
    (step) => step.id === "publish",
  );
  assert.match(publish.run, /release_plan\.py --tag "\$TAG"/);
  assert.ok(
    publish.run.indexOf("release_plan.py") <
      publish.run.indexOf("github_release.py publish"),
  );
  // An unpublished tag is never reused, and a resumed release is rebuilt
  // from the commit it was published at, never from another one.
  const tagCheck = prepare.find((step) =>
    step.name?.startsWith("Check the tag"),
  );
  assert.match(tagCheck.run, /A release tag is never reused/);
  assert.match(tagCheck.run, /Resume it by dispatching from that commit/);
});

test("platform builds are reusable workflows that never publish", () => {
  const release = workflow("release.yml");
  const builds = {
    edge: "./.github/workflows/edge-release.yml",
    windows: "./.github/workflows/windows-player-release.yml",
    android: "./.github/workflows/player-release.yml",
  };
  for (const [job, uses] of Object.entries(builds)) {
    assert.equal(release.jobs[job]?.uses, uses, job);
    assert.equal(release.jobs[job].secrets, "inherit", job);
    assert.match(
      String(release.jobs[job].with.release_version),
      /needs\.prepare\.outputs\.version/,
    );
    const called = workflow(uses.replace("./.github/workflows/", ""));
    assert.ok(Object.hasOwn(called.on, "workflow_call"), uses);
    const raw = readFileSync(uses, "utf8");
    // Building is read-only; the assembled release is the only thing published.
    assert.doesNotMatch(raw, /gh release (create|upload)|--publish\b/);
    assert.doesNotMatch(raw, /contents: write/);
    assert.match(raw, /actions\/upload-artifact@v7/);
    assert.match(raw, /scripts\/release\/stamp_version\.py/);
  }
  // The old per-platform release trains are gone.
  assert.deepEqual(workflow("player-release.yml").on.push, undefined);
  assert.equal(
    existsSync(".github/workflows/publish-linux-player-package.yml"),
    false,
  );
});

test("builds that are already verified in the draft are not built again", () => {
  const release = workflow("release.yml");
  const resume = release.jobs.prepare.steps.find(
    (step) => step.id === "resume",
  );
  assert.match(resume.run, /release_assemble\.py resume/);
  assert.match(resume.run, /tilecast-release-verify/);
  // A published release builds nothing.
  assert.match(resume.run, /pending='\[\]'/);
  for (const job of ["edge", "windows", "android", "server_image"]) {
    assert.match(
      release.jobs[job].if,
      /needs\.prepare\.outputs\.state != 'published'/,
      job,
    );
  }
  assert.match(release.jobs.edge.if, /edge_arches != '\[\]'/);
  assert.match(release.jobs.windows.if, /windows_arches != '\[\]'/);
  assert.match(release.jobs.android.if, /build_android == 'true'/);
  // A matrix is built from the architectures still pending.
  for (const file of ["edge-release.yml", "windows-player-release.yml"]) {
    assert.match(
      workflow(file).jobs.release.strategy.matrix.arch,
      /fromJSON\(inputs\.arches/,
    );
  }
});

test("a release is verified as the server would import it, then as GitHub holds it", () => {
  const release = workflow("release.yml");
  const steps = release.jobs.assemble.steps;
  const index = (predicate) => steps.findIndex(predicate);
  const collect = index((step) =>
    /release_assemble\.py collect/.test(step.run ?? ""),
  );
  const verify = index(
    (step) => /tilecast-release-verify/.test(step.run ?? "") && !step.id,
  );
  const build = index((step) =>
    /release_assemble\.py build/.test(step.run ?? ""),
  );
  const upload = index((step) =>
    /github_release\.py upload/.test(step.run ?? ""),
  );
  const readback = index((step) => step.id === "draft");
  assert.ok(
    collect >= 0 && verify >= 0 && build >= 0 && upload >= 0 && readback >= 0,
  );
  assert.ok(
    collect < verify && verify < build && build < upload && upload < readback,
    "expected collect < verify < build < upload < read back",
  );
  // Stray assets from an earlier run are pruned from the draft (never from a
  // published release) before the read back.
  assert.match(
    steps[upload].run,
    /github_release\.py prune "\$TAG" --dir "\$RUNNER_TEMP\/assets"/,
  );
  assert.ok(
    steps[upload].run.indexOf("github_release.py upload") <
      steps[upload].run.indexOf("github_release.py prune"),
  );
  // The read back verifies the downloaded draft against its inventory.
  assert.match(steps[readback].run, /github_release\.py download/);
  assert.match(steps[readback].run, /release_assemble\.py verify/);
  // Everything is a draft until the publish job flips it; replacing assets is
  // only ever done on the draft.
  assert.match(steps[upload].run, /github_release\.py create/);
  assert.match(
    steps[upload].run,
    /upload "\$TAG" --dir "\$RUNNER_TEMP\/upload" --replace/,
  );
  // The verifier is built from the server module and trusts the repository key.
  assert.match(release.env.UPDATE_KEY, /tilecast-update-key\.pem/);
});

test("publication is the commit point and needs a verified draft", () => {
  const release = workflow("release.yml");
  assert.deepEqual(release.jobs.publish.needs, ["prepare", "assemble"]);
  assert.match(
    release.jobs.publish.if,
    /needs\.assemble\.outputs\.ready == 'true'/,
  );
  assert.match(release.jobs.publish.if, /state == 'published'/);
  const publish = release.jobs.publish.steps.find(
    (step) => step.id === "publish",
  );
  assert.match(publish.run, /\$PUBLISH" != true/);
  assert.match(publish.run, /--latest/);
  assert.match(publish.run, /--not-latest/);
  // The tag is created at the release commit and must be exactly it.
  assert.match(
    publish.run,
    /test "\$\(git rev-parse "\$TAG\^\{commit\}"\)" = "\$GITHUB_SHA"/,
  );
  // No other workflow creates a public release.
  for (const file of readdirSync(".github/workflows")) {
    if (!file.endsWith(".yml") || file === "linux-player-release.yml") continue;
    const raw = readFileSync(`.github/workflows/${file}`, "utf8");
    assert.doesNotMatch(raw, /gh release create/, file);
    assert.doesNotMatch(raw, /\bgh release upload\b/, file);
  }
});

test("the release caller grants every called workflow its permissions", () => {
  const release = workflow("release.yml");
  const rank = { read: 1, write: 2 };
  const granted = release.permissions;
  assert.deepEqual(granted, {
    actions: "read",
    contents: "read",
    checks: "write",
  });
  // The jobs that talk to the releases API ask for exactly what they need.
  // prepare and assemble also read the earlier Server image from the registry.
  assert.deepEqual(release.jobs.publish.permissions, { contents: "write" });
  for (const job of ["prepare", "assemble"]) {
    assert.deepEqual(
      release.jobs[job].permissions,
      { contents: "write", packages: "read" },
      job,
    );
  }
  // A reusable workflow cannot elevate beyond its caller, so every called
  // workflow must fit inside the grant of the job that calls it. A calling
  // job may set its own permissions; otherwise it inherits the workflow's.
  for (const [name, job] of Object.entries(release.jobs)) {
    if (!job.uses?.startsWith("./")) continue;
    const callerGrant = job.permissions ?? granted;
    const called = workflow(job.uses.replace("./.github/workflows/", ""));
    assert.ok(Object.hasOwn(called.on, "workflow_call"), job.uses);
    const needed = { ...(called.permissions ?? {}) };
    for (const calledJob of Object.values(called.jobs)) {
      for (const [scope, level] of Object.entries(calledJob.permissions ?? {}))
        if (!needed[scope] || rank[needed[scope]] < rank[level])
          needed[scope] = level;
    }
    for (const [scope, level] of Object.entries(needed)) {
      assert.ok(
        callerGrant[scope] && rank[callerGrant[scope]] >= rank[level],
        `${name}: ${job.uses} needs ${scope}:${level}, caller grants ${callerGrant[scope] ?? "nothing"}`,
      );
    }
  }
});

test("a release gates on the complete server shipping bundle", () => {
  const release = workflow("release.yml");
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
    assert.ok(
      release.jobs.assemble.needs.includes(job),
      `${job} gates assembly`,
    );
  }
  // Assembly runs even when a platform failed, so the contract decides; the
  // gates are required explicitly.
  const gate = release.jobs.assemble.steps.find((step) =>
    step.name?.startsWith("Require the validation gates"),
  );
  assert.match(gate.run, /test\("_ci\$"\)/);
  assert.match(gate.run, /result != "success"/);
  assert.match(release.jobs.assemble.if, /!cancelled\(\)/);
});

test("the Server image publishes one immutable tag, and aliases move only after publication", () => {
  const image = workflow("server-release.yml");
  const raw = readFileSync(".github/workflows/server-release.yml", "utf8");
  const release = workflow("release.yml");
  // It is only a building block: no tag trigger, and it creates no release.
  assert.deepEqual(Object.keys(image.on), ["workflow_call"]);
  assert.doesNotMatch(raw, /gh release/);

  // One build publishes only the immutable versioned tag.
  const steps = image.jobs.build.steps;
  const builds = steps.filter(
    (step) => step.uses === "docker/build-push-action@v7",
  );
  assert.equal(builds.length, 1);
  const meta = steps.find((step) => step.id === "meta");
  assert.match(meta.with.tags, /inputs\.version/);
  assert.doesNotMatch(meta.with.tags, /value=stable|value=latest|value=beta/);
  assert.equal(builds[0].with.provenance, "mode=max");
  assert.equal(builds[0].with.sbom, true);
  assert.match(
    builds[0].with["build-args"],
    /VERSION_NUMBER=\$\{\{ inputs\.version \}\}/,
  );
  assert.match(
    builds[0].with["build-args"],
    /VERSION_CHANNEL=\$\{\{ inputs\.channel \}\}/,
  );
  // An image that already exists is resumed, never rebuilt over.
  assert.match(String(builds[0].if), /existing\.outputs\.digest == ''/);
  assert.match(raw, /already exists from another build/);

  // Order: the image builds, the draft is assembled and published, and only
  // then do aliases move. A failed release can never leave an alias pointing
  // at an unreleased build.
  assert.equal(release.jobs.server_image.with.stage, "build");
  assert.equal(release.jobs.promote.with.stage, "promote");
  assert.ok(release.jobs.assemble.needs.includes("server_image"));
  assert.deepEqual(release.jobs.promote.needs, ["prepare", "publish"]);
  assert.match(
    release.jobs.promote.if,
    /needs\.publish\.outputs\.published == 'true'/,
  );
  assert.match(release.jobs.promote.if, /aliases != '\[\]'/);
  assert.equal(
    release.jobs.promote.with.digest,
    "${{ needs.publish.outputs.digest }}",
  );

  // Promotion consumes the verified digest, never the version tag, and
  // rebuilds nothing. The last guard is a script with its own tests
  // (scripts/release/test_promote_aliases.py).
  const promote = image.jobs.promote.steps.find((step) =>
    step.run?.includes("promote-server-aliases.sh"),
  );
  assert.match(promote.env.PROMOTE_DIGEST, /inputs\.digest/);
  assert.match(promote.env.ALIASES, /inputs\.aliases/);
  assert.match(promote.env.RELEASE_CHANNEL, /inputs\.channel/);
  const script = readFileSync(
    "scripts/release/promote-server-aliases.sh",
    "utf8",
  );
  assert.ok(script.includes('source_ref="$image@$digest"'));
  assert.ok(!script.includes("RELEASE_VERSION"));
  assert.doesNotMatch(script, /build-push|docker build /);
  // Only known aliases move, and only a Stable release may claim stable or latest.
  assert.match(script, /stable \| latest\)/);
  assert.match(script, /A \$channel release must not move \$alias/);
  assert.match(script, /Refusing to move the unknown alias/);
});

test("a resumed release promotes the digest the published release records", () => {
  const release = workflow("release.yml");
  const aliases = release.jobs.publish.steps.find(
    (step) => step.id === "aliases",
  );
  // The published inventory records the digest; a resumed run recovers it from
  // there, and the aliases come from the planner, so none moves backwards.
  assert.match(
    aliases.run,
    /gh release download "\$TAG" --pattern tilecast-release\.json/,
  );
  assert.match(aliases.run, /\.id == "server" and \.status == "available"/);
  assert.match(aliases.run, /release_plan\.py --tag "\$TAG"/);
  assert.ok(
    !("if" in release.jobs.publish.steps.find((step) => step.id === "publish")),
  );
  assert.equal(
    release.jobs.publish.steps.find((step) => step.id === "aliases").if,
    "steps.publish.outputs.published == 'true'",
  );
});

test("the release workflow stamps and checks one version on every platform", () => {
  for (const [file, check] of [
    ["edge-release.yml", /versionCode/],
    ["windows-player-release.yml", /versionCode/],
    ["player-release.yml", /versionCode/],
  ]) {
    const raw = readFileSync(`.github/workflows/${file}`, "utf8");
    // The version reaches the shell through the environment, never by
    // interpolating a caller-controlled input into the script text.
    assert.match(raw, /stamp_version\.py --version "\$RELEASE_VERSION"/, file);
    for (const job of Object.values(workflow(file).jobs))
      for (const step of job.steps)
        assert.doesNotMatch(
          step.run ?? "",
          /\$\{\{\s*inputs\./,
          `${file}: ${step.name ?? step.run}`,
        );
    assert.match(raw, /release_version\.py code/, file);
    assert.match(raw, check, file);
  }
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

test("release files select their validation", () => {
  const selected = (paths) =>
    Object.entries(affected(paths))
      .filter(([, value]) => value)
      .map(([key]) => key)
      .sort();
  assert.ok(selected(["deploy/docker/compose.dev.yml"]).includes("container"));
  assert.ok(selected([".github/workflows/release.yml"]).includes("server"));
  assert.ok(
    selected([".github/workflows/server-release.yml"]).includes("server"),
  );
  assert.ok(
    selected([".github/workflows/validate-data-sources.yml"]).includes(
      "sources",
    ),
  );
});

test("components are carried forward only through a recorded, re-verified plan", () => {
  const release = workflow("release.yml");
  const steps = (job) => release.jobs[job].steps;
  const named = (job, name) =>
    steps(job).find((step) => step.name?.startsWith(name));

  // The decision is made once, in prepare, after a resumed draft's own
  // components are known, and it can only be turned off, never forced on.
  const prepare = steps("prepare").map((step) => step.id);
  assert.ok(prepare.indexOf("resume") < prepare.indexOf("reuse"));
  const reuse = steps("prepare").find((step) => step.id === "reuse");
  assert.match(reuse.run, /release_reuse\.py plan/);
  assert.match(reuse.run, /--pending "\$pending"/);
  assert.match(reuse.run, /--reuse "\$REUSE"/);
  assert.equal(
    reuse.env.REUSE,
    "${{ inputs.reuse_unchanged && 'on' || 'off' }}",
  );
  assert.equal(reuse.env.BASELINE, "${{ steps.plan.outputs.previous_tag }}");
  assert.equal(reuse.env.NEAREST, "${{ steps.plan.outputs.nearest_tag }}");
  // The build jobs read the decision, not the resume step.
  const outputs = release.jobs.prepare.outputs;
  for (const key of [
    "edge_arches",
    "windows_arches",
    "build_android",
    "build_server",
  ])
    assert.match(outputs[key], /steps\.reuse\.outputs\./, key);
  // Only what a plan says to build, and the draft does not hold, is built.
  assert.match(reuse.run, /select\(\.action == "build"/);

  // A resumed draft is resumed by image tag only for an image it built itself:
  // a Server carried forward has no tag of this version.
  const resume = steps("prepare").find((step) => step.id === "resume");
  assert.match(resume.run, /\.origin != "inherited"/);

  // The image job is skipped for a carried-forward Server.
  assert.match(release.jobs.server_image.if, /build_server == 'true'/);

  // The plan travels to assemble as a file artifact, outside the tilecast-*
  // pattern that assemble collects release assets from.
  const upload = steps("prepare").find(
    (step) =>
      step.uses?.startsWith("actions/upload-artifact") &&
      step.with.name === "release-reuse-plan",
  );
  assert.ok(upload);
  const download = steps("assemble").find(
    (step) =>
      step.uses?.startsWith("actions/download-artifact") &&
      step.with.name === "release-reuse-plan",
  );
  assert.ok(download);

  // Assemble reads the earlier releases again before anything is written, and
  // passes the same plan to the inventory.
  const order = steps("assemble").map((step) => step.name ?? "");
  const verify = order.findIndex((name) =>
    name.startsWith("Verify what is carried forward"),
  );
  const login = order.findIndex(
    (name, index) =>
      name.startsWith("Log in to GitHub Container Registry") && index < verify,
  );
  const build = order.findIndex((name) =>
    name.startsWith("Apply the release contract"),
  );
  assert.ok(
    login >= 0 && login < verify && verify < build,
    "log in, then re-verify, then build the inventory",
  );
  assert.match(
    named("assemble", "Verify what is carried forward").run,
    /release_reuse\.py reverify/,
  );
  assert.match(
    named("assemble", "Apply the release contract").run,
    /--reuse-plan "\$RUNNER_TEMP\/reuse-plan\/reuse-plan\.json"/,
  );

  // Nothing carried forward is uploaded: the draft holds only what was assembled.
  const upload_step = named("assemble", "Create or update the draft");
  assert.match(upload_step.run, /github_release\.py prune/);
});

test("the Edge bridge is a separate, verified, never-latest pre-release", () => {
  const bridge = workflow("edge-bridge-release.yml");
  assert.deepEqual(Object.keys(bridge.on), ["workflow_dispatch"]);
  assert.equal(bridge.on.workflow_dispatch.inputs.publish.default, false);
  // It shares the release lock, so it never races a coordinated release.
  assert.equal(bridge.concurrency.group, "tilecast-release");
  assert.equal(bridge.concurrency["cancel-in-progress"], false);
  // No input is interpolated into a shell script.
  for (const job of Object.values(bridge.jobs))
    for (const step of job.steps ?? [])
      assert.doesNotMatch(step.run ?? "", /\$\{\{\s*inputs\./, step.name);
  // Edge only, Beta channel, stamped as a bridge, and never the Server image.
  const edge = bridge.jobs.edge;
  assert.equal(edge.uses, "./.github/workflows/edge-release.yml");
  assert.equal(edge.with.bridge, true);
  assert.equal(edge.with.channel, "beta");
  const raw = readFileSync(".github/workflows/edge-bridge-release.yml", "utf8");
  assert.doesNotMatch(raw, /packages: write/);
  assert.doesNotMatch(raw, /server-release\.yml/);
  // The shipped helper must install the real bridge before a draft exists.
  const steps = bridge.jobs.assemble.steps.map((step) => step.name ?? "");
  const oracle = steps.findIndex((name) =>
    name.startsWith("The shipped 0.2.1 update helper"),
  );
  const draft = steps.findIndex((name) =>
    name.startsWith("Create or update the draft"),
  );
  const verify = steps.findIndex((name) =>
    name.startsWith("Verify the bridge as the server imports it"),
  );
  assert.ok(verify >= 0 && verify < oracle && oracle < draft);
  // Publishing needs a verified draft, and is never the latest release.
  const publish = bridge.jobs.publish;
  assert.match(publish.if, /assemble\.outputs\.ready == 'true'/);
  assert.match(
    publish.steps.map((s) => s.run ?? "").join("\n"),
    /publish "\$TAG" --not-latest/,
  );
  // The edge build stamps only Edge for a bridge.
  const edgeRelease = readFileSync(
    ".github/workflows/edge-release.yml",
    "utf8",
  );
  assert.match(
    edgeRelease,
    /stamp_version\.py --version "\$RELEASE_VERSION" --edge-only/,
  );
});

test("assemble collects a lone downloaded artifact that has no subdirectory", () => {
  // actions/download-artifact extracts a lone matching artifact straight into
  // its path: the reused assets of a resume that builds nothing, or the one
  // platform a release builds while it carries the others forward. The
  // directory itself must then be a source.
  const steps = workflow("release.yml").jobs.assemble.steps;
  const collect = steps.find(
    (step) => step.name === "Collect the release assets",
  );
  assert.match(
    collect.run,
    /find "\$RUNNER_TEMP\/artifacts" -maxdepth 1 -type f/,
  );
  assert.match(collect.run, /sources\+=\("\$RUNNER_TEMP\/artifacts"\)/);
  // The upload that skips reused assets looks only in the reuse artifact's own
  // directory: a lone build artifact in the root is never taken for reuse.
  const upload = steps.find((step) =>
    step.run?.includes("artifacts/tilecast-release-reuse/$name"),
  );
  assert.doesNotMatch(upload.run, /artifacts\/\$name/);
});
