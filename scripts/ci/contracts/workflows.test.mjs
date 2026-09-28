import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

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
    const check = jobs.required.steps.find((step) => step.env?.SELECTIONS);
    assert.ok(
      check,
      `${file}: aggregate must verify selected jobs, including skipped results`,
    );
    for (const job of validations.filter((job) => job !== "changes"))
      assert.ok(
        check.env.SELECTIONS.includes(`"${job}":`),
        `${file}: missing ${job} selection`,
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

test("change detectors need no npm install or workflow-YAML dependencies", () => {
  for (const file of ["pr-validation.yml", "ci-edge.yml"]) {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    const steps = workflow.jobs.changes.steps;
    assert.ok(
      steps.some((step) => step.run === "node --test scripts/ci/*.test.mjs"),
      file,
    );
    assert.ok(
      !steps.some((step) => /npm\s+(ci|install)/.test(step.run ?? "")),
      file,
    );
  }
  const pr = parse(readFileSync(".github/workflows/pr-validation.yml", "utf8"));
  assert.ok(pr.jobs.ci_contract.if.includes("outputs.ci"));
  assert.ok(pr.jobs.required.needs.includes("ci_contract"));
  const contract = parse(readFileSync(pr.jobs.ci_contract.uses, "utf8"));
  const steps = contract.jobs.validate.steps;
  const install = steps.findIndex((step) => /npm ci/.test(step.run ?? ""));
  const tests = steps.findIndex((step) =>
    /scripts\/ci\/contracts\//.test(step.run ?? ""),
  );
  assert.ok(install >= 0 && tests > install);
});
