import { tilecastBrandBug } from "./resolver";
import { describe, expect, it } from "vitest";

interface BrandBugPlugin {
  id: string;
  type: string;
  version: number;
  config: {
    name?: string;
    corner: string;
    imageAssetId?: string | null;
    imageVariantId?: string | null;
    imageAvailableFrom?: string | null;
    imageExpiresAt?: string | null;
    text?: string;
    widthPercent: number;
    textSizePercent: number;
    opacityPercent: number;
    marginPercent: number;
    textColor: string;
    backgroundStyle: string;
    startsAt?: string | null;
    endsAt?: string | null;
    priority: number;
  };
}

interface ActiveBrandBug {
  id: string;
  corner: string;
  imageSrc: string | null;
  text: string;
  widthPercent: number;
  textSizePercent: number;
  opacityPercent: number;
  marginPercent: number;
  textColor: string;
  backgroundStyle: string;
  priority: number;
}

interface BrandBugResolver {
  resolve(
    plugins: BrandBugPlugin[] | null | undefined,
    localNow: Date,
    clockOffsetMs?: number,
  ): ActiveBrandBug[];
}

const resolver = tilecastBrandBug;

function mark(overrides: Partial<BrandBugPlugin["config"]> = {}, id = "bug-1") {
  return {
    id,
    type: "brand_bug",
    version: 1,
    config: {
      name: "Sponsor",
      corner: "top_right",
      text: "Presented by Example",
      widthPercent: 12,
      textSizePercent: 3,
      opacityPercent: 85,
      marginPercent: 3,
      textColor: "#ffffff",
      backgroundStyle: "scrim",
      priority: 0,
      ...overrides,
    },
  } satisfies BrandBugPlugin;
}

const now = new Date("2026-09-15T12:00:00Z");

describe("brand bug resolution", () => {
  it("returns a text-only mark with no logo reference", () => {
    const [active] = resolver.resolve([mark()], now);
    expect(active).toMatchObject({
      corner: "top_right",
      imageSrc: null,
      text: "Presented by Example",
      backgroundStyle: "scrim",
    });
  });

  it("builds a cached-media URL once a variant is resolved", () => {
    const [active] = resolver.resolve(
      [mark({ imageAssetId: "asset-1", imageVariantId: "variant-1" })],
      now,
    );
    expect(active?.imageSrc).toBe("tcmedia://variant/asset-1/variant-1");
  });

  it("falls back to text when the server could not resolve a variant", () => {
    const [active] = resolver.resolve(
      [mark({ imageAssetId: "asset-1", imageVariantId: null })],
      now,
    );
    expect(active?.imageSrc).toBeNull();
    expect(active?.text).toBe("Presented by Example");
  });

  it("does not render a future or expired logo through the plugin path", () => {
    expect(
      resolver.resolve(
        [
          mark({
            imageAssetId: "asset-1",
            imageVariantId: "variant-1",
            imageAvailableFrom: "2026-09-15T13:00:00Z",
          }),
        ],
        now,
      )[0]?.imageSrc,
    ).toBeNull();
    expect(
      resolver.resolve(
        [
          mark({
            imageAssetId: "asset-1",
            imageVariantId: "variant-1",
            imageExpiresAt: "2026-09-15T11:00:00Z",
          }),
        ],
        now,
      )[0]?.imageSrc,
    ).toBeNull();
  });

  it("drops a mark left with neither a drawable logo nor text", () => {
    expect(
      resolver.resolve(
        [mark({ imageAssetId: "asset-1", imageVariantId: null, text: "  " })],
        now,
      ),
    ).toEqual([]);
  });

  it("ignores other plugin types and unknown versions", () => {
    const countdown = { ...mark(), type: "countdown_bar" };
    const future = { ...mark(), version: 2 };
    expect(resolver.resolve([countdown, future], now)).toEqual([]);
  });

  it("shows one mark per corner and lets different corners coexist", () => {
    const active = resolver.resolve(
      [
        mark({ corner: "bottom_left" }, "bug-b"),
        mark({ corner: "top_right", priority: 5 }, "bug-a"),
        mark({ corner: "top_right", priority: 50 }, "bug-c"),
      ],
      now,
    );
    expect(active.map((item) => [item.corner, item.id])).toEqual([
      ["top_right", "bug-c"],
      ["bottom_left", "bug-b"],
    ]);
  });

  it("breaks a priority tie on the stable instance id", () => {
    const active = resolver.resolve(
      [mark({}, "bug-z"), mark({}, "bug-a")],
      now,
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe("bug-a");
  });

  it("honors a campaign window on both ends", () => {
    const window = {
      startsAt: "2026-09-15T13:00:00Z",
      endsAt: "2026-09-20T00:00:00Z",
    };
    expect(resolver.resolve([mark(window)], now)).toEqual([]);
    expect(
      resolver.resolve([mark(window)], new Date("2026-09-16T00:00:00Z")),
    ).toHaveLength(1);
    expect(
      resolver.resolve([mark(window)], new Date("2026-09-20T00:00:00Z")),
    ).toEqual([]);
  });

  it("applies the server clock offset to the window", () => {
    const active = resolver.resolve(
      [mark({ startsAt: "2026-09-15T12:30:00Z" })],
      now,
      45 * 60_000,
    );
    expect(active).toHaveLength(1);
  });

  it("treats an unparsable bound as open-ended rather than hiding the mark", () => {
    expect(
      resolver.resolve([mark({ startsAt: "not-a-date", endsAt: "" })], now),
    ).toHaveLength(1);
  });

  it("clamps out-of-range presentation values from an older or newer server", () => {
    const [active] = resolver.resolve(
      [
        mark({
          widthPercent: 900,
          textSizePercent: 0,
          opacityPercent: 0,
          marginPercent: 99,
          textColor: "white",
          backgroundStyle: "blur",
        }),
      ],
      now,
    );
    expect(active).toMatchObject({
      widthPercent: 40,
      textSizePercent: 1,
      opacityPercent: 10,
      marginPercent: 20,
      textColor: "#ffffff",
      backgroundStyle: "none",
    });
  });

  it("ignores an unknown corner", () => {
    expect(resolver.resolve([mark({ corner: "middle" })], now)).toEqual([]);
  });

  it("tolerates a missing plugin array", () => {
    expect(resolver.resolve(null, now)).toEqual([]);
    expect(resolver.resolve(undefined, now)).toEqual([]);
  });
});
