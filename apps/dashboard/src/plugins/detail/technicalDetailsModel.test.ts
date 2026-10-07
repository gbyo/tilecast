import { describe, expect, it } from "vitest";
import { technicalRows } from "./technicalDetailsModel";

const t = ((key: string) => key) as Parameters<typeof technicalRows>[1];

describe("technicalRows", () => {
  it("drops empty facts and labels the rest", () => {
    const rows = technicalRows(
      { packageId: "acme.weather", digest: "", jobIds: ["a", "b"] },
      t,
    );
    expect(rows.map((row) => row.key)).toEqual(["packageId", "jobs"]);
    expect(rows[1]?.values).toEqual(["a", "b"]);
  });

  it("joins a contribution's kind, id, and path", () => {
    const [row] = technicalRows(
      {
        contributions: [
          { kind: "widget", id: "acme.w", path: "./widgets/w" },
          { kind: "dataSource", path: "./data/d" },
        ],
      },
      t,
    );
    expect(row?.values).toEqual([
      "widget · acme.w · ./widgets/w",
      "dataSource · ./data/d",
    ]);
  });
});
