import { describe, expect, it } from "vitest";
import { parseVersionCode } from "./self-update";

describe("parseVersionCode malformed semantic versions", () => {
  it("rejects incomplete or partially numeric version cores", () => {
    expect(parseVersionCode("1")).toBe(0);
    expect(parseVersionCode("1.2")).toBe(0);
    expect(parseVersionCode("1foo.2.3")).toBe(0);
    expect(parseVersionCode("1.2x.3")).toBe(0);
    expect(parseVersionCode("1.2.3rc1")).toBe(0);
  });

  it("continues to ignore valid prerelease and build suffixes", () => {
    expect(parseVersionCode("2.3.4-beta.1")).toBe(2_003_004);
    expect(parseVersionCode("2.3.4+build.7")).toBe(2_003_004);
  });
});
