import { describe, expect, it } from "vitest";
import { resolveWebsiteClockUrl, resolveWebsiteUrl } from "./url-template";
import type { ManifestDataSource } from "../compat/projection/content-types";

const at = new Date(2026, 10, 7, 9, 5, 4);
const source: ManifestDataSource = {
  id: "test",
  name: "Rooms",
  provider: "manual",
  configVersion: 2,
  configuration: {
    fields: [{ key: "room", label: "Room", type: "text" }],
    records: [
      { id: "1", values: { room: "Кабинет & 3" } },
      { id: "2", values: { room: "Актовый зал" } },
    ],
  },
};
const context = {
  screenId: "TV-123",
  at,
  dataSourceId: "test",
  dataSources: new Map([["test", source]]),
};

describe("Website URL variables", () => {
  it("preserves static encoded JSON query values", () => {
    const original =
      "https://example.org/?payload=%7B%22room%22%3A%22101%22%7D";
    expect(resolveWebsiteUrl(original, context)).toBe(original);
  });
  it("leaves old URLs unchanged", () => {
    const original = "https://example.org/x?x=%26&x=2";
    expect(resolveWebsiteUrl(original, context)).toBe(original);
  });
  it("defers clock tokens until the Website actually mounts", () => {
    const template = "https://example.org/display?room={data.room}&t={time}";
    const first = resolveWebsiteUrl(template, { ...context, deferClock: true });
    const later = resolveWebsiteUrl(template, {
      ...context,
      at: new Date(at.getTime() + 30_000),
      deferClock: true,
    });
    // Reprojection on the selection cadence must not change this item.
    expect(later).toBe(first);
    expect(first).toContain("t={time}");
    const mounted = resolveWebsiteClockUrl(
      first!,
      new Date(at.getTime() + 45_000),
    );
    expect(new URL(mounted!).searchParams.get("t")).toBe("09:05:49");
    expect(new URL(mounted!).searchParams.get("room")).toBe("Кабинет & 3");
  });
  it("keeps encoded literals even alongside authored and deferred tokens", () => {
    const url = resolveWebsiteUrl(
      "https://example.org/?literal=%7Btime%7D&payload=%7B%22room%22%3A101%7D:{screen.id}&t={time}",
      { ...context, deferClock: true },
    );
    const mounted = new URL(resolveWebsiteClockUrl(url!, at)!);
    expect(mounted.searchParams.get("literal")).toBe("{time}");
    expect(mounted.searchParams.get("payload")).toBe('{"room":101}:TV-123');
    expect(mounted.searchParams.get("t")).toBe("09:05:04");
  });
  it("checks the final length after deferred expansion", () => {
    const prefix = "https://example.org/?t=";
    const value = "a".repeat(2048 - prefix.length - "{datetime}".length);
    const url = resolveWebsiteUrl(`${prefix}${value}{datetime}`, {
      ...context,
      deferClock: true,
    });
    expect(url).toHaveLength(2048);
    expect(resolveWebsiteClockUrl(url!, at)).toBeNull();
  });
  it("resolves screen and wall clock values", () => {
    const resolved = resolveWebsiteUrl(
      "https://example.org/?s={screen.id}&d={date}&t={time}&dt={datetime}",
      context,
    );
    const parsed = new URL(resolved!);
    expect(parsed.searchParams.get("s")).toBe("TV-123");
    expect(parsed.searchParams.get("d")).toBe("2026-11-07");
    expect(parsed.searchParams.get("t")).toBe("09:05:04");
    expect(parsed.searchParams.get("dt")).toBe("2026-11-07T09:05:04");
  });
  it("encodes source fields and supports a selected record", () => {
    const resolved = new URL(
      resolveWebsiteUrl(
        "https://example.org/?room={data.room}&next={data.room:1}",
        context,
      )!,
    );
    expect(resolved.searchParams.get("room")).toBe("Кабинет & 3");
    expect(resolved.searchParams.get("next")).toBe("Актовый зал");
    expect(resolved.hostname).toBe("example.org");
  });
  it("preserves repeated parameter names", () => {
    const url = new URL(
      resolveWebsiteUrl(
        "https://example.org/?room={data.room}&room={data.room:1}",
        context,
      )!,
    );
    expect(url.searchParams.getAll("room")).toEqual([
      "Кабинет & 3",
      "Актовый зал",
    ]);
  });
  it("passes JSON without injecting new query parameters", () => {
    const resolved = new URL(
      resolveWebsiteUrl("https://example.org/?rooms={data.json}", context)!,
    );
    expect(JSON.parse(resolved.searchParams.get("rooms")!)).toEqual([
      { room: "Кабинет & 3" },
      { room: "Актовый зал" },
    ]);
  });
  it("handles a malformed percent sequence in a path without throwing", () => {
    const resolved = resolveWebsiteUrl(
      "https://example.org/100%/x?room={data.room}",
      context,
    );
    expect(resolved).not.toBeNull();
    const url = new URL(resolved!);
    expect(url.pathname).toBe("/100%/x");
    expect(url.searchParams.get("room")).toBe("Кабинет & 3");
  });
  it("does not resolve inherited object properties as fields", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(
        resolveWebsiteUrl(`https://example.org/?x={data.${name}}`, context),
      ).toBeNull();
    }
  });
  it("fails closed on missing data, unknown token, and unsafe placement", () => {
    expect(
      resolveWebsiteUrl("https://{screen.id}.org/?x=1", context),
    ).toBeNull();
    expect(resolveWebsiteUrl("https://example.org/{date}", context)).toBeNull();
    expect(
      resolveWebsiteUrl("https://example.org/?x={unknown}", context),
    ).toBeNull();
    expect(
      resolveWebsiteUrl("https://example.org/?x={data.room:99}", context),
    ).toBeNull();
    expect(
      resolveWebsiteUrl("https://example.org/?{date}=1", context),
    ).toBeNull();
  });
});
