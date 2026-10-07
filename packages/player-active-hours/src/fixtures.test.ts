/**
 * Cross-player active-hours cases. Player Core runs the same file in
 * crates/player-core/tests/active_hours_contract.rs and must produce the same
 * results, which holds the Rust and TypeScript Players to one rest policy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeHoursFromConfig,
  evaluateActiveHours,
  overridesActiveHours,
} from "./active-hours";

const FILE = resolve(
  __dirname,
  "../../settings-schema/active-hours-fixtures.json",
);

interface Document {
  cases: {
    name: string;
    power: Record<string, unknown>;
    at: string;
    expected: { active: boolean; msUntilTransition: number | null };
  }[];
  overrides: Record<string, boolean>;
}

const document = JSON.parse(readFileSync(FILE, "utf8")) as Document;
const run = (power: Record<string, unknown>, at: string) => {
  const result = evaluateActiveHours(
    activeHoursFromConfig(power),
    new Date(at),
  );
  return { active: result.active, msUntilTransition: result.msUntilTransition };
};

if (process.env.TILECAST_ACTIVE_HOURS_WRITE === "1") {
  for (const entry of document.cases)
    entry.expected = run(entry.power, entry.at);
  writeFileSync(FILE, `${JSON.stringify(document, null, 2)}\n`);
}

describe("cross-player active hours", () => {
  for (const entry of document.cases) {
    it(entry.name, () => {
      expect(run(entry.power, entry.at)).toEqual(entry.expected);
    });
  }

  it("names the selection sources that outrank rest", () => {
    for (const [source, overrides] of Object.entries(document.overrides)) {
      expect(overridesActiveHours(source), source).toBe(overrides);
    }
    expect(overridesActiveHours(undefined)).toBe(false);
  });
});
