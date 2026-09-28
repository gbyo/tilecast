import { tilecastAlertTicker } from "./resolver";
import { describe, expect, it } from "vitest";

interface PluginEntry {
  id: string;
  type: string;
  version: number;
  config: Record<string, unknown>;
}

interface AlertTickerResolver {
  resolve(
    plugins: PluginEntry[] | null | undefined,
    localNow: Date,
    clockOffsetMs?: number,
  ): {
    id: string;
    message: string;
    severity: string;
    displayMode: string;
    heightPx: number;
    pixelsPerSecond: number;
    expiresAt: string;
  } | null;
}

const resolver = tilecastAlertTicker;

const now = new Date("2026-07-29T12:00:00Z");

function ticker(overrides: Record<string, unknown> = {}): PluginEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "alert_ticker",
    version: 1,
    config: {
      name: "Tornadoes",
      message: "Tornado Warning — take shelter now",
      severity: "Extreme",
      displayMode: "push",
      heightPx: 96,
      speed: "medium",
      priority: 1000,
      expiresAt: "2026-07-29T12:30:00Z",
      ...overrides,
    },
  };
}

describe("alert ticker resolver", () => {
  it("shows a live alert with its geometry and travel rate", () => {
    const active = resolver.resolve([ticker()], now);
    expect(active?.message).toBe("Tornado Warning — take shelter now");
    expect(active?.severity).toBe("Extreme");
    expect(active?.displayMode).toBe("push");
    expect(active?.heightPx).toBe(96);
    expect(active?.pixelsPerSecond).toBe(120);
  });

  it("translates each named speed into a travel rate", () => {
    const rate = (speed: string) =>
      resolver.resolve([ticker({ speed })], now)?.pixelsPerSecond;
    expect(rate("slow")).toBe(60);
    expect(rate("fast")).toBe(200);
    // An unrecognized speed from a newer server still has to scroll readably.
    expect(rate("glacial")).toBe(120);
  });

  it("takes the bar down once the alert can no longer be current", () => {
    // The poller normally clears the activation, but an offline player has no
    // poller to hear from and must stop showing the alert on its own.
    expect(resolver.resolve([ticker()], new Date("2026-07-29T12:30:01Z"))).toBe(
      null,
    );
    expect(resolver.resolve([ticker({ expiresAt: "" })], now)).toBe(null);
    expect(resolver.resolve([ticker({ message: "   " })], now)).toBe(null);
  });

  it("applies the server clock offset before judging the expiry", () => {
    // A player whose clock is an hour behind must not keep an expired alert up.
    expect(resolver.resolve([ticker()], now, 3_600_000)).toBe(null);
  });

  it("ignores entries belonging to other plugins and other versions", () => {
    const countdown = {
      id: "22222222-2222-4222-8222-222222222222",
      type: "countdown_bar",
      version: 1,
      config: { message: "Lunch ends in" },
    };
    expect(resolver.resolve([countdown], now)).toBe(null);
    expect(resolver.resolve([{ ...ticker(), version: 2 }], now)).toBe(null);
    expect(resolver.resolve(null, now)).toBe(null);
  });

  it("keeps the longest-running alert when two are live at equal priority", () => {
    const later = ticker({ expiresAt: "2026-07-29T14:00:00Z" });
    const other = {
      ...ticker(),
      id: "33333333-3333-4333-8333-333333333333",
    };
    // Equal priority: the alert that runs longest holds the bar, so the surface
    // does not swap between two live warnings every poll.
    expect(resolver.resolve([other, later], now)?.id).toBe(later.id);
  });
});
