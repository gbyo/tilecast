import { describe, expect, it } from "vitest";
import type { DataSourceDefinition } from "../api/types";
import { initialDataSourceConfiguration } from "./dataSourceDefaults";

const publicHolidays: Pick<
  DataSourceDefinition,
  "id" | "defaultConfiguration"
> = {
  id: "public-holidays",
  defaultConfiguration: { year: 2026 },
};

describe("initialDataSourceConfiguration", () => {
  it("uses the current year for a new Public Holidays source", () => {
    expect(initialDataSourceConfiguration(publicHolidays, 2027)).toEqual({
      year: 2027,
    });
    expect(publicHolidays.defaultConfiguration).toEqual({ year: 2026 });
  });

  it("preserves other catalog defaults", () => {
    const definition: Pick<
      DataSourceDefinition,
      "id" | "defaultConfiguration"
    > = {
      id: "local-feed",
      defaultConfiguration: { feedUrl: "https://example.test/feed", count: 5 },
    };
    expect(initialDataSourceConfiguration(definition, 2027)).toEqual(
      definition.defaultConfiguration,
    );
  });
});
