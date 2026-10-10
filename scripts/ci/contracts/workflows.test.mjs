import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const aggregateEnv = (validations, overrides = {}) => {
  const env = { ...process.env, CHANGES_RESULT: "success" };
  for (const job of validations.filter((job) => job !== "changes")) {
    const prefix = job.toUpperCase();
    env[`${prefix}_SELECTED`] = "false";
    env[`${prefix}_RESULT`] = "skipped";
  }
  return { ...env, ...overrides };
};

test("native Player dependency gate is part of required CI contracts", () => {
  const workflow = parse(
    readFileSync(".github/workflows/validate-ci-contract.yml", "utf8"),
  );
  const commands = workflow.jobs.validate.steps
    .map((step) => step.run ?? "")
    .join("\n");
  assert.match(commands, /python3 scripts\/ci\/check-player-architecture\.py/);
  assert.match(commands, /unittest discover.*test_player_architecture\.py/);
});

test("workflow YAML and aggregate dependencies stay complete", () => {
  for (const file of readdirSync(".github/workflows").filter((file) =>
    file.endsWith(".yml"),
  )) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"), {
      uniqueKeys: true,
    });
    const jobs = workflow.jobs;
    if (!jobs?.required) continue;
    const validations = Object.keys(jobs)
      .filter((job) => job !== "required")
      .sort();
    assert.deepEqual(
      [...jobs.required.needs].sort(),
      validations,
      `${file}: aggregate must include every job`,
    );
    assert.equal(jobs.required.if, "always()");
    const check = jobs.required.steps.find(
      (step) => step.env?.CHANGES_RESULT && step.run,
    );
    assert.ok(check, `${file}: aggregate must verify selected jobs`);
    for (const job of validations.filter((job) => job !== "changes")) {
      const prefix = job.toUpperCase();
      assert.ok(
        Object.hasOwn(check.env, `${prefix}_SELECTED`),
        `${file}: missing ${job} selection`,
      );
      assert.ok(
        Object.hasOwn(check.env, `${prefix}_RESULT`),
        `${file}: missing ${job} result`,
      );
      assert.match(
        check.run,
        new RegExp(`check ${job} `),
        `${file}: aggregate does not check ${job}`,
      );
    }

    const passing = spawnSync("bash", ["-c", check.run], {
      env: aggregateEnv(validations),
      encoding: "utf8",
    });
    assert.equal(
      passing.status,
      0,
      `${file}: unselected skipped jobs should pass\n${passing.stderr}`,
    );

    const selectedJob = validations.find((job) => job !== "changes");
    if (selectedJob) {
      const prefix = selectedJob.toUpperCase();
      const selectedSkip = spawnSync("bash", ["-c", check.run], {
        env: aggregateEnv(validations, {
          [`${prefix}_SELECTED`]: "true",
          [`${prefix}_RESULT`]: "skipped",
        }),
        encoding: "utf8",
      });
      assert.notEqual(
        selectedSkip.status,
        0,
        `${file}: a selected skipped job must fail closed`,
      );
    }

    const detectorFailure = spawnSync("bash", ["-c", check.run], {
      env: aggregateEnv(validations, { CHANGES_RESULT: "failure" }),
      encoding: "utf8",
    });
    assert.notEqual(
      detectorFailure.status,
      0,
      `${file}: detector failure must fail the aggregate`,
    );
  }
});

test("reusable jobs resolve to a workflow_call contract", () => {
  for (const file of ["pr-validation.yml", "ci-edge.yml"]) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    for (const job of Object.values(workflow.jobs)) {
      if (!job.uses?.startsWith("./")) continue;
      const called = parse(readFileSync(job.uses, "utf8"));
      assert.ok(Object.hasOwn(called.on, "workflow_call"), job.uses);
    }
  }
});

test("Linux release packaging is path-gated on PRs and full on main", () => {
  const pr = parse(readFileSync(".github/workflows/pr-validation.yml", "utf8"));
  const linux = parse(
    readFileSync(".github/workflows/validate-linux.yml", "utf8"),
  );
  assert.equal(
    pr.jobs.changes.outputs.linux_release_contract,
    "${{ steps.paths.outputs.linux_release_contract }}",
  );
  assert.equal(
    pr.jobs.linux_player_ci.with.release_contract,
    "${{ github.event_name != 'pull_request' || needs.changes.outputs.linux_release_contract == 'true' }}",
  );
  assert.equal(linux.on.workflow_call.inputs.release_contract.type, "boolean");
  assert.equal(
    linux.jobs.release_contract.if,
    "${{ inputs.release_contract }}",
  );
  assert.ok(linux.jobs.release_contract.needs.includes("validate"));
  assert.ok(
    linux.jobs.validate.steps.some((step) =>
      /player:linux:test/.test(step.run ?? ""),
    ),
  );
  assert.ok(
    linux.jobs.validate.steps.some((step) =>
      /player:linux:build/.test(step.run ?? ""),
    ),
  );
  assert.ok(
    linux.jobs.release_contract.steps.some((step) =>
      /build-linux-player-release\.sh/.test(step.run ?? ""),
    ),
  );
  assert.ok(pr.jobs.required.needs.includes("linux_player_ci"));
});

test("Dashboard validation runs independently and makes coverage optional", () => {
  const dashboard = parse(
    readFileSync(".github/workflows/ci-dashboard.yml", "utf8"),
  );
  const jobs = dashboard.jobs;
  assert.ok(jobs.lint && jobs.tests && jobs.build && jobs.coverage);
  assert.equal(dashboard.on.workflow_call.inputs.coverage.type, "boolean");
  assert.equal(dashboard.on.workflow_call.inputs.coverage.default, true);
  assert.equal(jobs.lint.needs, undefined);
  assert.equal(jobs.tests.needs, undefined);
  assert.equal(jobs.build.needs, undefined);
  assert.deepEqual(jobs.tests.strategy.matrix.shard, [1, 2]);
  assert.deepEqual(jobs.coverage.needs, "tests");
  assert.equal(jobs.coverage.if, "${{ always() && inputs.coverage }}");

  const shardRun = jobs.tests.steps.find((step) =>
    /Run Vitest shard/.test(step.name ?? ""),
  );
  assert.match(shardRun?.run ?? "", /--shard=\$\{\{ matrix\.shard \}\}\/2/);
  assert.match(shardRun?.run ?? "", /--reporter=junit/);
  assert.match(shardRun?.run ?? "", /--reporter=blob/);
  assert.match(shardRun?.run ?? "", /npm run coverage/);
  assert.match(shardRun?.run ?? "", /npm test/);
  assert.match(shardRun?.run ?? "", /--outputFile\.junit=.*matrix\.shard/);

  const shardReporter = jobs.tests.steps.find((step) =>
    /Test Reporter/.test(step.name ?? ""),
  );
  assert.match(
    shardReporter?.with?.path ?? "",
    /vitest-\$\{\{ matrix\.shard \}\}\.xml/,
  );

  const coverageMerge = jobs.coverage.steps.find((step) =>
    /Merge shard coverage/.test(step.name ?? ""),
  );
  assert.match(coverageMerge?.run ?? "", /--merge-reports=vitest-reports/);
  assert.match(coverageMerge?.run ?? "", /--coverage/);
  assert.ok(
    jobs.coverage.steps.some((step) =>
      /coverage-summary\.json/.test(step.run ?? ""),
    ),
  );
});

test("Dashboard and Linux Player install only their npm workspace graphs", () => {
  const dashboard = parse(
    readFileSync(".github/workflows/ci-dashboard.yml", "utf8"),
  );
  for (const name of ["lint", "tests", "build", "coverage"]) {
    const dashboardInstall = dashboard.jobs[name].steps.find((step) =>
      /^npm ci/.test(step.run ?? ""),
    );
    assert.equal(
      dashboardInstall?.run,
      "npm ci --workspace @tilecast/dashboard --include-workspace-root",
      `Dashboard CI ${name} needs its workspace and root tooling, but not every workspace`,
    );
  }

  const linux = parse(
    readFileSync(".github/workflows/validate-linux.yml", "utf8"),
  );
  for (const name of ["validate", "release_contract"]) {
    const linuxInstall = linux.jobs[name].steps.find((step) =>
      /^npm ci/.test(step.run ?? ""),
    );
    assert.equal(
      linuxInstall?.run,
      "npm ci --workspace @gibsonmb71/tilecast-player-linux",
      `Linux Player CI ${name} should use its lockfile-resolved workspace graph`,
    );
  }
});

test("Dashboard and Server jobs publish timing summaries with read-only Actions access", () => {
  // Dashboard CI measures each Vitest shard; Server CI is one job.
  for (const [file, jobName, reportArg] of [
    ["ci-dashboard.yml", "tests", "--junit"],
    ["ci-server.yml", "validate", "--go-json"],
  ]) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    assert.equal(workflow.permissions.actions, "read", file);
    const job = workflow.jobs[jobName];
    assert.equal(
      (job.permissions ?? workflow.permissions).actions,
      "read",
      file,
    );
    const summary = job.steps.find((step) =>
      /timing-summary\.mjs/.test(step.run ?? ""),
    );
    assert.ok(summary, `${file}: missing timing summary`);
    assert.equal(summary.if, "always()", file);
    assert.match(summary.run, new RegExp(`${reportArg} `), file);
  }

  for (const file of ["pr-validation.yml", "ci-heavy.yml", "release.yml"]) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    assert.equal(workflow.permissions.actions, "read", file);
  }
});

test("PR reusable validations receive every required permission from their calling job", () => {
  const workflow = parse(
    readFileSync(".github/workflows/pr-validation.yml", "utf8"),
  );
  const rank = { none: 0, read: 1, write: 2 };
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!job.uses?.startsWith("./.github/workflows/")) continue;
    const called = parse(readFileSync(job.uses, "utf8"));
    const grant = job.permissions ?? workflow.permissions;
    for (const [scope, level] of Object.entries(called.permissions ?? {})) {
      assert.ok(
        (rank[grant[scope]] ?? 0) >= rank[level],
        `${name}: ${job.uses} requires ${scope}:${level}; calling job grants ${grant[scope] ?? "none"}`,
      );
    }
  }
});

test("change detectors run only the dependency-free affected graph gate", () => {
  for (const file of ["pr-validation.yml", "ci-edge.yml"]) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    const steps = workflow.jobs.changes.steps;
    assert.ok(
      steps.some(
        (step) => step.run === "node --test scripts/ci/affected.test.mjs",
      ),
      file,
    );
    assert.ok(
      !steps.some((step) => /npm\s+(ci|install)/.test(step.run ?? "")),
      file,
    );
    assert.ok(
      !steps.some((step) => /doctor\.test|required\.test/.test(step.run ?? "")),
      `${file}: non-classifier helper tests must not delay fan-out`,
    );
  }
  const pr = parse(readFileSync(".github/workflows/pr-validation.yml", "utf8"));
  assert.ok(pr.jobs.ci_contract.if.includes("outputs.ci"));
  assert.ok(pr.jobs.required.needs.includes("ci_contract"));
  const contract = parse(readFileSync(pr.jobs.ci_contract.uses, "utf8"));
  const steps = contract.jobs.validate.steps;
  const helperTests = steps.findIndex(
    (step) =>
      /doctor\.test\.mjs/.test(step.run ?? "") &&
      /required\.test\.mjs/.test(step.run ?? ""),
  );
  const install = steps.findIndex((step) => /npm ci/.test(step.run ?? ""));
  const tests = steps.findIndex((step) =>
    /scripts\/ci\/contracts\//.test(step.run ?? ""),
  );
  assert.ok(helperTests >= 0 && helperTests < install);
  assert.ok(install >= 0 && tests > install);
});

const workflow = (file) =>
  parse(readFileSync(`.github/workflows/${file}`, "utf8"), {
    uniqueKeys: true,
  });

test("pull requests run only the deterministic checks", () => {
  const pr = workflow("pr-validation.yml");
  assert.equal(
    pr.jobs.ios_ci,
    undefined,
    "iOS CI belongs to Extended validation",
  );
  assert.equal(
    pr.jobs.e2e_ci.with?.visual,
    false,
    "no screenshots on pull requests",
  );
  assert.equal(
    pr.jobs.dashboard_ci.with?.coverage,
    "${{ github.event_name != 'pull_request' }}",
    "coverage belongs on main/release validation, not the PR gate",
  );
  assert.equal(
    pr.jobs.android_ci.with?.conformance,
    false,
    "no emulator on pull requests",
  );
  assert.equal(
    pr.jobs.android_ci.with?.host_boot,
    false,
    "no emulator on pull requests",
  );
  const windows = workflow("ci-windows.yml");
  assert.match(
    windows.jobs.conformance.if,
    /github\.event_name != 'pull_request'/,
    "WebView2 conformance must not run on pull requests",
  );
  assert.match(
    windows.jobs.required.steps.find((step) => step.env?.CONFORMANCE_SELECTED)
      .env.CONFORMANCE_SELECTED,
    /github\.event_name != 'pull_request'/,
  );
});

test("CodeQL workflows do not start for unrelated pull requests", () => {
  for (const file of [
    "codeql-dashboard.yml",
    "codeql-server.yml",
    "codeql-android.yml",
  ]) {
    const codeql = workflow(file);
    assert.ok(
      Array.isArray(codeql.on.pull_request.paths) &&
        codeql.on.pull_request.paths.length > 0,
      `${file}: pull_request must be path-filtered`,
    );
  }
});

test("Extended validation runs on a schedule and on demand, and never gates", () => {
  const extended = workflow("extended-validation.yml");
  assert.deepEqual(Object.keys(extended.on).sort(), [
    "schedule",
    "workflow_dispatch",
  ]);
  assert.equal(
    extended.jobs.required,
    undefined,
    "an aggregate would make it a gate",
  );
  for (const job of Object.values(extended.jobs)) {
    const called = parse(readFileSync(job.uses, "utf8"));
    assert.ok(Object.hasOwn(called.on, "workflow_call"), job.uses);
  }
  assert.deepEqual(
    Object.values(extended.jobs)
      .map((job) => job.uses)
      .sort(),
    [
      "./.github/workflows/ci-android.yml",
      "./.github/workflows/ci-ios.yml",
      "./.github/workflows/validate-browser.yml",
    ],
  );
  assert.deepEqual(extended.jobs.android_emulator.with, {
    validate: false,
    conformance: true,
    host_boot: true,
  });
  assert.deepEqual(extended.jobs.studio_visual.with, {
    smoke: false,
    visual: true,
  });
});

test("the visual suite skips itself inside a seeded schedule window", () => {
  const browser = workflow("validate-browser.yml");
  const steps = browser.jobs.validate.steps;
  const clock = steps.findIndex((step) => step.id === "clock");
  const visual = steps.findIndex((step) => step.id === "visual");
  assert.ok(clock >= 0 && visual > clock, "the clock check must come first");
  assert.match(steps[visual].if, /steps\.clock\.outputs\.active != 'true'/);
  assert.match(steps[visual].if, /inputs\.visual/);
  assert.match(
    steps.find((step) => /smoke/.test(step.name ?? "")).if,
    /inputs\.smoke/,
  );
});

test("documentation formatting is checked on changed files for pull requests", () => {
  const docs = workflow("validate-docs.yml");
  const step = docs.jobs.validate.steps.find((s) =>
    /formatting/.test(s.name ?? ""),
  );
  assert.match(step.run, /pull_request/);
  assert.match(step.run, /git diff --name-only/);
});

test("a failed Dashboard test shard is not reported a second time by the merge", () => {
  const dashboard = workflow("ci-dashboard.yml");
  const merge = dashboard.jobs.coverage.steps.find((s) =>
    /Merge shard coverage/.test(s.name ?? ""),
  );
  assert.match(
    String(merge["continue-on-error"]),
    /needs\.tests\.result != 'success'/,
  );
});

test("the snapshot refresh runs on demand, on a branch, and refuses a schedule window", () => {
  const refresh = workflow("refresh-visual-snapshots.yml");
  assert.deepEqual(Object.keys(refresh.on), ["workflow_dispatch"]);
  assert.match(refresh.jobs.refresh.if, /refs\/heads\/main/);
  assert.equal(refresh.permissions.contents, "write");
  const steps = refresh.jobs.refresh.steps;
  const clock = steps.findIndex((step) => step.id === "clock");
  const render = steps.findIndex((step) =>
    /--update-snapshots/.test(step.run ?? ""),
  );
  assert.ok(clock >= 0 && render > clock, "check the clock before rendering");
  assert.ok(
    steps.some(
      (step) => /exit 1/.test(step.run ?? "") && /clock/.test(step.if ?? ""),
    ),
  );
});
