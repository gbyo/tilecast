// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import { summarizeFleet } from "./attention";
import { screen } from "./fixtures";
import {
  deriveRecap,
  recapMessage,
  type OverviewRecap,
  type RecapInput,
  type RecapPlayback,
} from "./recap";

function fleet(online: number, total: number) {
  return summarizeFleet(
    Array.from({ length: total }, (_, index) =>
      screen({
        id: `s${index}`,
        status: index < online ? "online" : "offline",
      }),
    ),
  );
}

const unavailable: RecapPlayback = { state: "unavailable" };

function playback(healthy: number, impaired: number, measured: number) {
  return { state: "ready", healthy, impaired, measured } as const;
}

function recap(
  online: number,
  total: number,
  overrides: Partial<Omit<RecapInput, "summary">> = {},
) {
  return deriveRecap({
    summary: fleet(online, total),
    attentionCount: 0,
    incidents: "ready",
    playback: unavailable,
    ...overrides,
  });
}

async function say(recapValue: OverviewRecap | null, language = "en") {
  await i18n.changeLanguage(language);
  const { key, options } = recapMessage(recapValue!);
  return i18n.t(key, { ns: "activity", ...options });
}

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("deriveRecap connection tiers", () => {
  it("says nothing for an installation with no screens", () => {
    expect(recap(0, 0)).toBeNull();
  });

  it.each([
    [10, 10, "allOnline"],
    [7, 10, "mostOnline"],
    [2, 3, "mostOnline"],
    [6, 10, "someOnline"],
    [1, 2, "someOnline"],
    [1, 3, "someOnline"],
    [3, 10, "fewOnline"],
    [1, 4, "fewOnline"],
    [0, 10, "noneOnline"],
  ])("%i of %i online is %s", (online, total, kind) => {
    expect(recap(online, total)?.kind).toBe(kind);
  });

  it("draws the boundaries with integers, not rounded ratios", () => {
    // 2/3 is "most"; one screen fewer is not.
    expect(recap(4, 6)?.kind).toBe("mostOnline");
    expect(recap(3, 6)?.kind).toBe("someOnline");
    // 1/3 is not "only"; one screen fewer is.
    expect(recap(2, 6)?.kind).toBe("someOnline");
    expect(recap(1, 6)?.kind).toBe("fewOnline");
  });

  it("treats a one-screen installation as a screen, not a fleet", () => {
    expect(recap(1, 1)).toEqual({
      kind: "singleScreen",
      online: true,
      needsAttention: false,
    });
    expect(recap(0, 1, { attentionCount: 1 })).toEqual({
      kind: "singleScreen",
      online: false,
      needsAttention: true,
    });
  });
});

describe("deriveRecap attention", () => {
  it("carries an exact count once incidents have loaded", () => {
    expect(recap(7, 10, { attentionCount: 4 })).toEqual({
      kind: "mostOnline",
      online: 7,
      total: 10,
      attention: { kind: "exact", count: 4 },
    });
  });

  it("adds attention to a fully online fleet", () => {
    expect(recap(10, 10, { attentionCount: 2 })).toMatchObject({
      kind: "allOnline",
      attention: { kind: "exact", count: 2 },
    });
  });

  it("makes no claim about attention while incidents load", () => {
    expect(
      recap(7, 10, { attentionCount: 2, incidents: "loading" }),
    ).toMatchObject({ kind: "mostOnline", attention: { kind: "none" } });
  });

  it("calls proven issues a floor when incidents failed", () => {
    expect(
      recap(7, 10, { attentionCount: 2, incidents: "failed" }),
    ).toMatchObject({ attention: { kind: "atLeast", count: 2 } });
  });

  it("does not claim a clean fleet when incidents failed and nothing is proven", () => {
    expect(recap(7, 10, { incidents: "failed" })).toMatchObject({
      kind: "mostOnline",
      attention: { kind: "none" },
    });
  });
});

describe("deriveRecap playback", () => {
  it("reports healthy playback when every screen is online and confirmed", () => {
    expect(recap(10, 10, { playback: playback(10, 0, 10) })).toEqual({
      kind: "allOnlineHealthyPlayback",
      total: 10,
    });
  });

  it("flags online screens with no healthy playback", () => {
    expect(recap(10, 10, { playback: playback(0, 3, 10) })).toEqual({
      kind: "allOnlineNoHealthyPlayback",
      total: 10,
    });
  });

  it("stays quiet about playback when only some of it is healthy", () => {
    expect(recap(10, 10, { playback: playback(7, 3, 10) })?.kind).toBe(
      "allOnline",
    );
  });

  it("does not read a fleet with nothing to play as unhealthy", () => {
    // Off hours or nothing assigned: all unmeasured, none impaired.
    expect(recap(10, 10, { playback: playback(0, 0, 10) })?.kind).toBe(
      "allOnline",
    );
  });

  it("does not claim healthy playback the screen list cannot back up", () => {
    expect(recap(10, 10, { playback: playback(9, 0, 9) })?.kind).toBe(
      "allOnline",
    );
  });

  it("omits playback entirely when analytics are unavailable", () => {
    expect(recap(10, 10, { playback: unavailable })?.kind).toBe("allOnline");
  });

  it("prefers the attention sentence over playback", () => {
    expect(
      recap(10, 10, { attentionCount: 2, playback: playback(0, 3, 10) }),
    ).toMatchObject({ kind: "allOnline", attention: { count: 2 } });
  });

  it("makes no playback claim while attention is unknown", () => {
    for (const incidents of ["loading", "failed"] as const) {
      expect(
        recap(10, 10, { incidents, playback: playback(10, 0, 10) })?.kind,
      ).toBe("allOnline");
    }
  });

  it("never folds playback into a fleet that is not fully online", () => {
    expect(recap(7, 10, { playback: playback(7, 0, 10) })?.kind).toBe(
      "mostOnline",
    );
  });

  it("covers a one-screen installation", () => {
    expect(recap(1, 1, { playback: playback(1, 0, 1) })).toEqual({
      kind: "singleScreenHealthyPlayback",
    });
    expect(recap(1, 1, { playback: playback(0, 1, 1) })).toEqual({
      kind: "singleScreenNoHealthyPlayback",
    });
  });
});

describe("recap sentences", () => {
  const cases: [string, OverviewRecap | null, string][] = [
    ["all online", recap(10, 10), "All 10 screens are online."],
    [
      "all online with attention",
      recap(10, 10, { attentionCount: 2 }),
      "All 10 screens are online, but 2 need attention.",
    ],
    [
      "all online with one attention",
      recap(10, 10, { attentionCount: 1 }),
      "All 10 screens are online, but 1 needs attention.",
    ],
    [
      "mostly online",
      recap(7, 10, { attentionCount: 4 }),
      "Most of your fleet is online, but 4 screens need attention.",
    ],
    [
      "mostly online, one issue",
      recap(7, 10, { attentionCount: 1 }),
      "Most of your fleet is online, but 1 screen needs attention.",
    ],
    [
      "mostly online, issues floor",
      recap(7, 10, { attentionCount: 2, incidents: "failed" }),
      "Most of your fleet is online, but at least 2 screens need attention.",
    ],
    [
      "mostly online, incidents loading",
      recap(7, 10, { attentionCount: 2, incidents: "loading" }),
      "Most of your fleet is online.",
    ],
    [
      "partial",
      recap(6, 10, { attentionCount: 4 }),
      "6 of 10 screens are online, and 4 need attention.",
    ],
    [
      "low",
      recap(3, 10, { attentionCount: 7 }),
      "Only 3 of 10 screens are online, and 7 need attention.",
    ],
    [
      "one of four",
      recap(1, 4, { attentionCount: 3 }),
      "Only 1 of 4 screens is online, and 3 need attention.",
    ],
    [
      "none",
      recap(0, 6, { attentionCount: 6 }),
      "No screens are online, and 6 need attention.",
    ],
    [
      "none, issues floor",
      recap(0, 6, { attentionCount: 6, incidents: "failed" }),
      "No screens are online, and at least 6 need attention.",
    ],
    [
      "healthy playback",
      recap(10, 10, { playback: playback(10, 0, 10) }),
      "All 10 screens are online and reporting healthy playback.",
    ],
    [
      "no healthy playback",
      recap(10, 10, { playback: playback(0, 4, 10) }),
      "All 10 screens are online, but none is reporting healthy playback.",
    ],
    ["single online", recap(1, 1), "Your screen is online."],
    [
      "single offline",
      recap(0, 1, { attentionCount: 1 }),
      "Your screen isn’t online, and it needs attention.",
    ],
  ];

  it.each(cases)("%s", async (_name, value, sentence) => {
    expect(await say(value)).toBe(sentence);
  });

  it("names the fleet in Spanish", async () => {
    expect(await say(recap(7, 10, { attentionCount: 4 }), "es")).toBe(
      "La mayor parte de tu flota está en línea, pero 4 pantallas requieren atención.",
    );
    expect(await say(recap(1, 4, { attentionCount: 1 }), "es")).toBe(
      "Solo 1 de 4 pantallas está en línea, y 1 requiere atención.",
    );
  });

  it("inflects Russian by the number each phrase counts", async () => {
    expect(await say(recap(7, 10, { attentionCount: 4 }), "ru")).toBe(
      "Большая часть парка экранов в сети, но 4 экрана требуют внимания.",
    );
    expect(await say(recap(10, 10, { attentionCount: 1 }), "ru")).toBe(
      "Все 10 экранов в сети, но 1 требует внимания.",
    );
    expect(await say(recap(21, 21), "ru")).toBe("Все 21 экран в сети.");
    expect(await say(recap(12, 21, { attentionCount: 5 }), "ru")).toBe(
      "12 из 21 экрана в сети, и 5 требуют внимания.",
    );
    expect(await say(recap(2, 23, { attentionCount: 2 }), "ru")).toBe(
      "В сети только 2 из 23 экранов, и 2 требуют внимания.",
    );
    expect(
      await say(
        recap(7, 10, { attentionCount: 21, incidents: "failed" }),
        "ru",
      ),
    ).toBe(
      "Большая часть парка экранов в сети, но как минимум 21 экран требует внимания.",
    );
  });
});
