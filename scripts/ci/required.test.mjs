import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRequired } from "./required.mjs";

test("only unselected jobs may skip", () => {
  const needs = {
    changes: { result: "success" },
    widgets: { result: "skipped" },
  };
  validateRequired(needs, { widgets: false });
  assert.throws(
    () => validateRequired(needs, { widgets: true }),
    /selected=true/,
  );
});
test("failure, cancellation and detector failure fail closed", () => {
  for (const result of ["failure", "cancelled"]) {
    assert.throws(() =>
      validateRequired(
        { changes: { result: "success" }, widgets: { result } },
        { widgets: false },
      ),
    );
    assert.throws(() => validateRequired({ changes: { result } }, {}));
  }
});
test("missing dependencies and missing selection contracts fail closed", () => {
  assert.throws(
    () =>
      validateRequired({ changes: { result: "success" } }, { widgets: true }),
    /missing/,
  );
  assert.throws(
    () =>
      validateRequired(
        { changes: { result: "success" }, widgets: { result: "success" } },
        {},
      ),
    /selection/,
  );
});
