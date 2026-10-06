import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/errors";
import type { Screen } from "../../api/types";
import {
  addScreensInBatch,
  groupHealth,
  isGroupNotFound,
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

describe("addScreensInBatch concurrency", () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("adds one screen at a time by default", async () => {
    let inFlight = 0;
    let peak = 0;
    const add = () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return Promise.resolve().then(() => {
        inFlight -= 1;
      });
    };
    await addScreensInBatch(["a", "b", "c"], add);
    expect(peak).toBe(1);
  });

  it("never exceeds the limit and reports in input order", async () => {
    const pending = new Map(
      ["a", "b", "c", "d"].map((id) => [id, deferred()] as const),
    );
    let inFlight = 0;
    let peak = 0;
    const add = (id: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return (pending.get(id) as ReturnType<typeof deferred>).promise.finally(
        () => {
          inFlight -= 1;
        },
      );
    };
    const result = addScreensInBatch(["a", "b", "c", "d"], add, 2);
    // Settle out of order: later screens finish first, one fails.
    pending.get("b")?.resolve();
    pending.get("a")?.reject(new Error("conflict"));
    await Promise.resolve();
    pending.get("d")?.resolve();
    pending.get("c")?.resolve();
    const outcome = await result;
    expect(peak).toBeLessThanOrEqual(2);
    expect(outcome.added).toEqual(["b", "c", "d"]);
    expect(outcome.failed.map((item) => item.id)).toEqual(["a"]);
  });

  it("returns an empty outcome for no screens", async () => {
    const add = vi.fn(() => Promise.resolve());
    expect(await addScreensInBatch([], add)).toEqual({ added: [], failed: [] });
    expect(add).not.toHaveBeenCalled();
  });

  it("treats a synchronous throw as a failed screen", async () => {
    const outcome = await addScreensInBatch(["a", "b"], (id) => {
      if (id === "a") throw new Error("boom");
      return Promise.resolve();
    });
    expect(outcome.added).toEqual(["b"]);
    expect(outcome.failed.map((item) => item.id)).toEqual(["a"]);
  });
});

describe("isGroupNotFound", () => {
  it("keys off the 404 status, not a domain-specific code", () => {
    expect(isGroupNotFound(new ApiError("x", 404, "schedule_not_found"))).toBe(
      true,
    );
    expect(
      isGroupNotFound(new ApiError("x", 404, "display_group_not_found")),
    ).toBe(true);
    expect(isGroupNotFound(new ApiError("x", 500, "schedule_not_found"))).toBe(
      false,
    );
    expect(isGroupNotFound(new Error("network"))).toBe(false);
    expect(isGroupNotFound(null)).toBe(false);
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
