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

test("Dashboard and Linux Player install only their npm workspace graphs", () => {
  const dashboard = parse(
    readFileSync(".github/workflows/ci-dashboard.yml", "utf8"),
  );
  const dashboardInstall = dashboard.jobs.validate.steps.find((step) =>
    /^npm ci/.test(step.run ?? ""),
  );
  assert.equal(
    dashboardInstall?.run,
    "npm ci --workspace @tilecast/dashboard --include-workspace-root",
    "Dashboard CI needs its workspace and root tooling, but not every workspace",
  );

  const linux = parse(
    readFileSync(".github/workflows/validate-linux.yml", "utf8"),
  );
  const linuxInstall = linux.jobs.validate.steps.find((step) =>
    /^npm ci/.test(step.run ?? ""),
  );
  assert.equal(
    linuxInstall?.run,
    "npm ci --workspace @gibsonmb71/tilecast-player-linux",
    "Linux Player CI should use its lockfile-resolved workspace graph",
  );
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
