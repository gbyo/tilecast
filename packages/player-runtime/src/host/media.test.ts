import { describe, expect, it } from "vitest";
import { AuthorizedMedia } from "./media";

describe("host-authorized media", () => {
  it("uses opaque same-origin grants without constructing a native URI", () => {
    const media = new AuthorizedMedia();
    media.replace([
      { assetId: "a", variantId: "v", uri: "/player/media/opaque" },
    ]);
    expect(media.resolve("a", "v")).toBe("/player/media/opaque");
    expect(() => media.resolve("a", "other")).toThrow("not authorized");
  });

  it("revokes old bindings when the host replaces its snapshot", () => {
    const media = new AuthorizedMedia();
    media.replace([
      { assetId: "a", variantId: "v", uri: "tcmedia://cap/opaque" },
    ]);
    media.replace();
    expect(() => media.resolve("a", "v")).toThrow("not authorized");
  });

  it("rejects ambiguous bindings without changing the current grants", () => {
    const media = new AuthorizedMedia();
    const binding = {
      assetId: "a",
      variantId: "v",
      uri: "/player/media/opaque",
    };
    media.replace([binding]);
    expect(() => media.replace([binding, binding])).toThrow("duplicate");
    expect(media.resolve("a", "v")).toBe(binding.uri);
  });
});
