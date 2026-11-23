import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CONNECTIONS,
  MAX_MAX_RESPONSE_BYTES,
  originText,
  parseCanonicalOrigin,
  parseOrigin,
} from "../src/connections.ts";

interface OriginCase {
  input: string;
  operator: string | null;
  canonical?: boolean;
}

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "testdata", "origins.json"), "utf8"),
) as { cases: OriginCase[] };

// The same cases run through the Go SDK (go/plugin/origin_test.go).
describe("connection origins", () => {
  it.each(fixtures.cases)("reads $input", ({ input, operator, canonical }) => {
    const origin = parseOrigin(input);
    if (operator === null) {
      expect(origin).toBeNull();
      return;
    }
    expect(origin).not.toBeNull();
    expect(originText(origin!)).toBe(operator);
    expect(parseCanonicalOrigin(input) !== null).toBe(canonical);
  });

  it("keeps the Go bounds", () => {
    const go = readFileSync(
      join(import.meta.dirname, "..", "go", "plugin", "connections_v3.go"),
      "utf8",
    );
    expect(go).toContain(`MaxConnections       = ${MAX_CONNECTIONS}`);
    expect(MAX_MAX_RESPONSE_BYTES).toBe(16 << 20);
    expect(go).toContain("MaxMaxResponseBytes     = 16 << 20");
  });
});
