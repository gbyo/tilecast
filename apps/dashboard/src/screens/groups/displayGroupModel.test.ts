import { describe, expect, it, vi } from "vitest";
import type { Screen } from "../../api/types";
import {
  addScreensInBatch,
  groupHealth,
  groupPath,
  pickerScreens,
  savedPresentationValue,
  screenInventory,
} from "./displayGroupModel";

const screen = (id: string, over: Partial<Screen> = {}) =>
  ({
    id,
    name: id,
    location: "",
    status: "online",
    enabled: true,
    ...over,
  }) as Screen;

describe("groupHealth", () => {
  const group = {
    membershipCount: 3,
    screens: ["a", "b", "c"].map((id) => ({ id, name: id, location: "" })),
  };

  it("uses Fleet's classification for online and attention", () => {
    const inventory = screenInventory([
      screen("a"),
      screen("b", { status: "offline" }),
      screen("c", { status: "online", updateError: "failed" }),
    ]);
    expect(groupHealth(group, inventory)).toEqual({
      total: 3,
      online: 2,
      attention: 2,
      known: true,
    });
  });

  it("does not invent health before the inventory loads", () => {
    expect(groupHealth(group, undefined)).toMatchObject({
      total: 3,
      known: false,
    });
  });
});

describe("pickerScreens", () => {
  const inventory = [
    screen("member"),
    screen("free", { name: "Free screen", location: "Lobby" }),
    screen("taken", { syncGroupId: "other", syncGroupName: "Other" }),
    screen("mine", { syncGroupId: "group-1" }),
  ];

  it("omits members and separates screens owned by another group", () => {
    const result = pickerScreens(inventory, "group-1", new Set(["member"]), "");
    expect(result.available.map((s) => s.id)).toEqual(["free", "mine"]);
    expect(result.elsewhere.map((s) => s.id)).toEqual(["taken"]);
  });

  it("searches name and location across both lists", () => {
    const result = pickerScreens(inventory, "group-1", new Set(), "lobby");
    expect(result.available.map((s) => s.id)).toEqual(["free"]);
    expect(result.elsewhere).toEqual([]);
  });
});

describe("addScreensInBatch", () => {
  it("reports each outcome instead of assuming all or nothing", async () => {
    const add = vi.fn((id: string) =>
      id === "b" ? Promise.reject(new Error("conflict")) : Promise.resolve(),
    );
    const outcome = await addScreensInBatch(["a", "b", "c"], add);
    expect(add).toHaveBeenCalledTimes(3);
    expect(outcome.added).toEqual(["a", "c"]);
    expect(outcome.failed.map((f) => f.id)).toEqual(["b"]);
  });
});

describe("helpers", () => {
  it("builds tab paths and reads the stored fallback", () => {
    expect(groupPath("g")).toBe("/groups/g");
    expect(groupPath("g", "members")).toBe("/groups/g?tab=members");
    expect(savedPresentationValue({ layoutId: "l" })).toBe("layout:l");
    expect(savedPresentationValue({ playlistId: "p" })).toBe("playlist:p");
    expect(savedPresentationValue({})).toBe("none");
  });
});
