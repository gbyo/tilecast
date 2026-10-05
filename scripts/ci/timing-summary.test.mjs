import assert from "node:assert/strict";
import { test } from "node:test";

import { parseGoTestJSON, parseJUnit } from "./timing-summary.mjs";

test("JUnit timing reports rank files and tests and decode XML names", () => {
  const report = parseJUnit(`
    <testsuites>
      <testsuite name="src/fast.test.ts" tests="1" time="0.4">
        <testcase classname="src/fast.test.ts" name="quick &gt; check" time="0.1" />
      </testsuite>
      <testsuite name="src/slow.test.ts" tests="2" time="2.5">
        <testcase classname="src/slow.test.ts" name="slow case" time="2.1" />
        <testcase classname="src/slow.test.ts" name="other case" time="0.4" />
      </testsuite>
    </testsuites>
  `);

  assert.deepEqual(report.files, [
    { name: "src/slow.test.ts", seconds: 2.5 },
    { name: "src/fast.test.ts", seconds: 0.4 },
  ]);
  assert.equal(report.tests[0].name, "slow case");
  assert.equal(report.tests[2].name, "quick > check");
});

test("Go JSON timing reports rank package and terminal test events", () => {
  const report = parseGoTestJSON(
    [
      { Action: "run", Package: "example/fast", Test: "TestFast" },
      {
        Action: "pass",
        Package: "example/fast",
        Test: "TestFast",
        Elapsed: 0.2,
      },
      { Action: "pass", Package: "example/fast", Elapsed: 0.5 },
      {
        Action: "fail",
        Package: "example/slow",
        Test: "TestSlow",
        Elapsed: 3.2,
      },
      { Action: "fail", Package: "example/slow", Elapsed: 3.5 },
      { Action: "output", Package: "example/slow", Output: "not a timing" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );

  assert.deepEqual(report.packages, [
    { name: "example/slow", seconds: 3.5, result: "fail" },
    { name: "example/fast", seconds: 0.5, result: "pass" },
  ]);
  assert.deepEqual(report.tests, [
    {
      package: "example/slow",
      name: "TestSlow",
      seconds: 3.2,
      result: "fail",
    },
    {
      package: "example/fast",
      name: "TestFast",
      seconds: 0.2,
      result: "pass",
    },
  ]);
});
