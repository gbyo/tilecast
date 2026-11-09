import { describe, expect, it } from "vitest";
import { resolveWebsiteUrl } from "./url-template";
import type { ManifestDataSource } from "../compat/projection/content-types";

const at = new Date(2026, 10, 7, 9, 5, 4);
const source: ManifestDataSource = {
  id: "test", name: "Rooms", provider: "manual", configVersion: 2,
  configuration: {
    fields: [{ key: "room", label: "Room", type: "text" }],
    records: [{ id: "1", values: { room: "Кабинет & 3" } }, { id: "2", values: { room: "Актовый зал" } }],
  },
};
const context = {
  screenId: "TV-123",
  at,
  dataSourceId: "test",
  dataSources: new Map([["test", source]]),
};

describe("Website URL variables", () => {
  it("leaves old URLs unchanged", () => {
    const original = "https://example.org/x?x=%26&x=2";
    expect(resolveWebsiteUrl(original, context)).toBe(original);
  });
  it("resolves screen and wall clock values", () => {
    const resolved = resolveWebsiteUrl("https://example.org/?s={screen.id}&d={date}&t={time}&dt={datetime}", context);
    const parsed = new URL(resolved!);
    expect(parsed.searchParams.get("s")).toBe("TV-123");
    expect(parsed.searchParams.get("d")).toBe("2026-11-07");
    expect(parsed.searchParams.get("t")).toBe("09:05:04");
    expect(parsed.searchParams.get("dt")).toBe("2026-11-07T09:05:04");
  });
  it("encodes source fields and supports a selected record", () => {
    const resolved = new URL(resolveWebsiteUrl("https://example.org/?room={data.room}&next={data.room:1}", context)!);
    expect(resolved.searchParams.get("room")).toBe("Кабинет & 3");
    expect(resolved.searchParams.get("next")).toBe("Актовый зал");
    expect(resolved.hostname).toBe("example.org");
  });
  it("preserves repeated parameter names", () => {
    const url = new URL(resolveWebsiteUrl("https://example.org/?room={data.room}&room={data.room:1}", context)!);
    expect(url.searchParams.getAll("room")).toEqual(["Кабинет & 3", "Актовый зал"]);
  });
  it("passes JSON without injecting new query parameters", () => {
    const resolved = new URL(resolveWebsiteUrl("https://example.org/?rooms={data.json}", context)!);
    expect(JSON.parse(resolved.searchParams.get("rooms")!)).toEqual([
      { room: "Кабинет & 3" }, { room: "Актовый зал" }
    ]);
  });
  it("fails closed on missing data, unknown token, and unsafe placement", () => {
    expect(resolveWebsiteUrl("https://{screen.id}.org/?x=1", context)).toBeNull();
    expect(resolveWebsiteUrl("https://example.org/{date}", context)).toBeNull();
    expect(resolveWebsiteUrl("https://example.org/?x={unknown}", context)).toBeNull();
    expect(resolveWebsiteUrl("https://example.org/?x={data.room:99}", context)).toBeNull();
    expect(resolveWebsiteUrl("https://example.org/?{date}=1", context)).toBeNull();
  });
});
