import { describe, expect, it } from "vitest";
import {
  configFieldsSchema,
  configSchemaProblems,
  normalizeConfigValues,
  type ConfigField,
  type ConfigProfile,
} from "../src/index.ts";
import schemas from "../testdata/schemas.json" with { type: "json" };
import values from "../testdata/values.json" with { type: "json" };

// The same fixtures run against the Go validator in go/configschema, so the
// two halves accept and refuse the same documents.

describe("schema fixtures", () => {
  it("has enough fixtures to mean something", () => {
    expect(schemas.length).toBeGreaterThan(10);
  });
  for (const fixture of schemas as {
    name: string;
    profile: ConfigProfile;
    valid: boolean;
    fields: unknown[];
  }[]) {
    it(fixture.name, () => {
      const parsed = configFieldsSchema(fixture.profile).safeParse(fixture.fields);
      expect(parsed.success).toBe(fixture.valid);
    });
  }
});

describe("value fixtures", () => {
  for (const fixture of values as {
    name: string;
    fields: ConfigField[];
    input: Record<string, unknown>;
    valid: boolean;
    output?: Record<string, unknown>;
  }[]) {
    it(fixture.name, () => {
      expect(configSchemaProblems(fixture.fields, "plugin")).toEqual([]);
      const result = normalizeConfigValues(fixture.fields, fixture.input);
      expect(result.ok).toBe(fixture.valid);
      if (result.ok && fixture.output) expect(result.values).toEqual(fixture.output);
    });
  }
});

describe("profiles", () => {
  it("refuses plugin-only semantics in a Widget schema", () => {
    const problems = configSchemaProblems(
      [
        { key: "token", label: "Token", control: "secret" },
        { key: "who", label: "Who", control: "text", personal: { retentionDays: 3 } },
      ],
      "widget",
    );
    expect(problems).toContain(
      'configuration schema uses the plugin-only control "secret"',
    );
    expect(problems).toContain('field "who" uses the plugin-only personal marker');
  });
});
