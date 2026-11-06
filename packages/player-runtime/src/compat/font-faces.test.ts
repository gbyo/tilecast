import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isProjectedFontFace,
  libraryFamilyName,
  registerFontFaces,
  resetRegisteredFontFaces,
} from "./font-faces";

const FONT = "5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f";
const family = libraryFamilyName(FONT);
const face = {
  family,
  src: "tcmedia://cap/" + "b".repeat(64),
  weight: "100 900",
  style: "normal",
  unicodeRange: "U+0000-00FF,U+0131",
};

class FakeFontFace {
  static created: FakeFontFace[] = [];
  static fail = false;
  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors: FontFaceDescriptors,
  ) {
    FakeFontFace.created.push(this);
  }
  load(): Promise<this> {
    return FakeFontFace.fail
      ? Promise.reject(new Error("network"))
      : Promise.resolve(this);
  }
}

describe("library font faces", () => {
  beforeEach(() => {
    resetRegisteredFontFaces();
    FakeFontFace.created = [];
    FakeFontFace.fail = false;
    vi.stubGlobal("FontFace", FakeFontFace);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("accepts only generated family names, safe sources, weights, and ranges", () => {
    expect(isProjectedFontFace(face)).toBe(true);
    expect(isProjectedFontFace({ ...face, src: "/player/media/3/cap" })).toBe(
      true,
    );
    for (const bad of [
      { ...face, family: "Inter" },
      { ...face, family: "tcf-x; color: red" },
      { ...face, src: 'tcmedia://cap/a") url("https://evil' },
      { ...face, src: "tcmedia://cap/a b" },
      { ...face, src: "relative/path.woff2" },
      { ...face, weight: "bold" },
      { ...face, weight: "100 900 1000" },
      { ...face, style: "oblique" },
      { ...face, unicodeRange: "U+0000; }" },
    ]) {
      expect(isProjectedFontFace(bad)).toBe(false);
    }
  });

  it("registers a face once per identity and reuses it across new grants", async () => {
    const added: unknown[] = [];
    const set = { add: (value: unknown) => added.push(value) };
    await registerFontFaces(
      [face, { ...face, src: "tcmedia://cap/" + "c".repeat(64) }],
      set,
    );
    expect(added).toHaveLength(1);
    const created = FakeFontFace.created[0]!;
    expect(created.family).toBe(family);
    expect(created.source).toBe(`url("${face.src}")`);
    expect(created.descriptors).toMatchObject({
      weight: "100 900",
      style: "normal",
      unicodeRange: "U+0000-00FF,U+0131",
      display: "block",
    });
  });

  it("ignores invalid faces and retries a face that failed to load", async () => {
    const added: unknown[] = [];
    const deleted: unknown[] = [];
    const set = {
      add: (value: unknown) => added.push(value),
      delete: (value: unknown) => deleted.push(value),
    };
    FakeFontFace.fail = true;
    await registerFontFaces([face, { ...face, family: "Inter" }], set);
    expect(added).toHaveLength(1);
    expect(deleted).toHaveLength(1);
    FakeFontFace.fail = false;
    await registerFontFaces([face], set);
    expect(added).toHaveLength(2);
  });
});
