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

  describe("library fonts", () => {
    const at = Date.parse("2026-10-15T00:00:00Z");
    const id = "5C0A2F8E-3C1B-4D2A-9E7F-0A1B2C3D4E5F";
    const face = {
      assetId: "1f8f2d8e-1b1a-4c55-9a0d-3d2f6c7b8a90",
      variantId: "7b6a5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d",
      style: "italic",
      weightMin: 100,
      weightMax: 900,
      unicodeRange: "U+0000-00FF",
    };

    it("routes declared families with lower-case identities", () => {
      const parsed = parseStateEntry(
        { ...fixture, fonts: [{ id, family: "Inter", faces: [face] }] },
        at,
      );
      if (typeof parsed === "string") throw new Error(parsed);
      expect(parsed.entry.fonts).toEqual([
        { id: id.toLowerCase(), family: "Inter", faces: [face] },
      ]);
      const plain = parseStateEntry(fixture, at);
      if (typeof plain === "string") throw new Error(plain);
      expect(plain.entry.fonts).toEqual([]);
    });

    it("refuses malformed families like malformed media", () => {
      const family = { id, family: "Inter", faces: [face] };
      for (const fonts of [
        "Inter",
        Array(5).fill(family),
        [{ ...family, id: "nope" }],
        [{ ...family, faces: [{ ...face, style: "oblique" }] }],
        [{ ...family, faces: [{ ...face, assetId: "x" }] }],
        [{ ...family, faces: [{ ...face, weightMin: 1.5 }] }],
      ]) {
        const parsed = parseStateEntry({ ...fixture, fonts }, at);
        expect(typeof parsed).toBe("string");
      }
    });
  });
});
