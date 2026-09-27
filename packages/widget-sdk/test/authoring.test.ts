import { describe, expect, it } from "vitest";
import {
  authoringUiOf,
  groupAuthoringFields,
  visibleAuthoringFields,
} from "../src/authoring.ts";

const fields = [
  { key: "timezone", ui: { section: "content", order: 1 } },
  { key: "format", ui: { section: "content", order: 2 } },
  {
    key: "showDate",
    ui: { section: "appearance", visibleWhen: { key: "style", notEquals: "minimal" } },
  },
  { key: "style", ui: { section: "appearance", order: 1, styleCard: true } },
  { key: "dataSourceId", ui: { section: "data", order: 1 } },
  { key: "legacy", control: "text" },
];

describe("authoring metadata", () => {
  it("reads hints tolerantly", () => {
    expect(authoringUiOf({ key: "a" })).toEqual({});
    expect(authoringUiOf({ key: "a", ui: "content" })).toEqual({});
    expect(authoringUiOf({ key: "a", ui: { section: "sidebar" } })).toEqual(
      {},
    );
    expect(
      authoringUiOf({ key: "a", ui: { section: "data", order: 2 } }),
    ).toEqual({ section: "data", order: 2 });
  });

  it("hides conditionally invisible controls and keeps manifest order", () => {
    expect(
      visibleAuthoringFields(fields, { style: "minimal" }).map((f) => f.key),
    ).toEqual(["timezone", "format", "style", "dataSourceId", "legacy"]);
    expect(
      visibleAuthoringFields(fields, { style: "standard" }).map((f) => f.key),
    ).toEqual([
      "timezone",
      "format",
      "showDate",
      "style",
      "dataSourceId",
      "legacy",
    ]);
  });

  it("matches equals against scalars and lists", () => {
    const gated = [
      {
        key: "detail",
        ui: { visibleWhen: { key: "style", equals: ["standard", "analog"] } },
      },
    ];
    expect(visibleAuthoringFields(gated, { style: "analog" })).toHaveLength(1);
    expect(visibleAuthoringFields(gated, { style: "minimal" })).toHaveLength(0);
    expect(visibleAuthoringFields(gated, {})).toHaveLength(0);
  });

  it("groups visible fields by section in canonical order", () => {
    const groups = groupAuthoringFields(
      visibleAuthoringFields(fields, { style: "standard" }),
    );
    expect(groups.map((g) => g.section)).toEqual([
      "data",
      "content",
      "appearance",
    ]);
    expect(groups[1]!.fields.map((f) => f.key)).toEqual([
      "timezone",
      "format",
      "legacy",
    ]);
    expect(groups[2]!.fields.map((f) => f.key)).toEqual([
      "style",
      "showDate",
    ]);
  });
});
