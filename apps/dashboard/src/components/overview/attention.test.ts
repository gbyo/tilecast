import { describe, expect, it } from "vitest";
import {
  deriveAttention,
  idleScreenCount,
  onAirScreens,
  summarizeFleet,
} from "./attention";
import { incident, screen } from "./fixtures";

describe("deriveAttention", () => {
  it("lists nothing for a healthy fleet", () => {
    expect(
      deriveAttention([screen(), screen({ id: "b", name: "Hall" })]),
    ).toEqual([]);
  });

  it("gives offline and stale screens a status reason", () => {
    const items = deriveAttention([
      screen({ id: "a", name: "A", status: "stale" }),
      screen({ id: "b", name: "B", status: "offline" }),
    ]);
    expect(items.map((item) => item.screen.name)).toEqual(["B", "A"]);
    expect(items[0]?.reasons).toEqual([{ kind: "status", status: "offline" }]);
  });

  it("explains an online screen that appears only because its update failed", () => {
    const items = deriveAttention([
      screen({ status: "online", updateError: "install_failed" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.reasons).toEqual([{ kind: "updateFailed" }]);
  });

  it("does not treat a reconnecting or deliberately disabled screen as a fault", () => {
    expect(
      deriveAttention([
        screen({ id: "a", status: "recent" }),
        screen({ id: "b", status: "disabled" }),
      ]),
    ).toEqual([]);
  });

  it("keeps revoked screens but ranks them below live faults", () => {
    const items = deriveAttention([
      screen({ id: "a", name: "A", status: "revoked" }),
      screen({ id: "b", name: "B", updateError: "x" }),
    ]);
    expect(items.map((item) => item.screen.name)).toEqual(["B", "A"]);
  });

  it("adds playback, storage and safe-mode incidents the status cannot show", () => {
    const items = deriveAttention(
      [screen()],
      [incident({ incidentType: "storage", severity: "warning" })],
    );
    expect(items[0]?.reasons).toEqual([
      { kind: "incident", incidentType: "storage", severity: "warning" },
    ]);
  });

  it("drops an incident that repeats what the row already says", () => {
    const items = deriveAttention(
      [screen({ status: "offline", updateError: "x" })],
      [
        incident({ incidentType: "connectivity" }),
        incident({ id: "i2", incidentType: "update" }),
      ],
    );
    expect(items[0]?.reasons.map((reason) => reason.kind)).toEqual([
      "status",
      "updateFailed",
    ]);
  });

  it("ignores closed incidents and incidents for screens not in the list", () => {
    expect(
      deriveAttention(
        [screen()],
        [
          incident({ status: "resolved" }),
          incident({ id: "i2", status: "recovered" }),
          incident({ id: "i3", primaryScreenId: "elsewhere" }),
        ],
      ),
    ).toEqual([]);
  });

  it("puts a critical incident ahead of a stale screen", () => {
    const items = deriveAttention(
      [
        screen({ id: "a", name: "A", status: "stale" }),
        screen({ id: "b", name: "B" }),
      ],
      [incident({ primaryScreenId: "b", severity: "critical" })],
    );
    expect(items.map((item) => item.screen.name)).toEqual(["B", "A"]);
  });
});

describe("fleet summaries", () => {
  it("counts every status without deciding which are healthy", () => {
    const summary = summarizeFleet([
      screen({ id: "a" }),
      screen({ id: "b", status: "offline" }),
      screen({ id: "c", status: "disabled" }),
    ]);
    expect(summary).toMatchObject({ total: 3, online: 1 });
    expect(summary.byStatus.offline).toBe(1);
    expect(summary.byStatus.disabled).toBe(1);
  });

  it("lists only online screens with content assigned as on air", () => {
    const screens = [
      screen({ id: "a", name: "B", nowPlayingName: "Menu" }),
      screen({ id: "b", name: "A", nowPlayingName: "Loop" }),
      screen({ id: "c", status: "offline", nowPlayingName: "Menu" }),
      screen({ id: "d", name: "Empty" }),
    ];
    expect(onAirScreens(screens).map((item) => item.name)).toEqual(["A", "B"]);
    expect(idleScreenCount(screens)).toBe(1);
  });
});
