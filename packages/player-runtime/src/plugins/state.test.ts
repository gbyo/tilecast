import { describe, expect, it } from "vitest";
import { parseStateEntry } from "./state";

const [source] = Object.values(
  import.meta.glob<string>(
    "../../../manifest-schema/plugin-state-entry-fixture.json",
    { query: "?raw", import: "default", eager: true },
  ),
);
const fixture = JSON.parse(source ?? "null") as Record<string, unknown>;

describe("plugin_state entries", () => {
  // The same fixture runs through the Server, Player Core, Edge, Windows,
  // and Android tests, and the SDK tests validate it against schema-v21.json.
  it("accepts the shared fixture", () => {
    const parsed = parseStateEntry(fixture, Date.parse("2026-10-15T00:00:00Z"));
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.plugin).toBe("sample_beacon");
    expect(parsed.entry).toMatchObject({
      type: "sample_beacon",
      version: 1,
      state: { label: "Lobby", level: 3 },
      validUntil: "2030-01-01T00:00:00Z",
    });
  });

  it("refuses malformed, oversized, or expired entries without throwing", () => {
    const at = Date.parse("2026-10-15T00:00:00Z");
    for (const [change, reason] of [
      [{ version: 2 }, "unsupported plugin_state version"],
      [{ plugin: "Not-Valid" }, "invalid plugin"],
      [{ state: [1] }, "state is not an object"],
      [{ state: { x: "a".repeat(16 * 1024) } }, "state is too large"],
      [
        { media: [{ assetId: "x", variantId: "y" }] },
        "invalid media reference",
      ],
      [{ validUntil: "2020-01-01T00:00:00Z" }, "expired"],
    ] as const) {
      expect(parseStateEntry({ ...fixture, ...change }, at)).toBe(reason);
    }
  });
});
