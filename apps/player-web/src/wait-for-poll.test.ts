import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { BrowserPlayer, nextPollDelay, waitForPoll } from "./player";

it("wakes at the server's next boundary before the regular poll", () => {
  expect(nextPollDelay(10_000, 1700, 2000)).toBe(300);
  expect(nextPollDelay(10_000, 1999, 2000)).toBe(1);
  expect(nextPollDelay(10_000, 1700, 20_000)).toBe(10_000);
  expect(nextPollDelay(10_000, 1700, null)).toBe(10_000);
  expect(nextPollDelay(10_000, 2100, 2000)).toBeGreaterThan(0);
});

it("uses the latest reconciliation boundary after a sync command", async () => {
  type TestPlan = { validUntil: Date | null };
  const previous: TestPlan = { validUntil: null };
  const fresh: TestPlan = { validUntil: new Date(2000) };
  // Exercise the real command-poll methods without constructing a DOM host.
  const player = Object.create(BrowserPlayer.prototype) as {
    syncNow(): Promise<void>;
    pollCommands(plan: TestPlan | null): Promise<TestPlan | null>;
  };
  let sync = true;
  Object.assign(player, {
    link: { server: {}, bound: {} },
    reconcile: async () => fresh,
    commands: {
      poll: async () => {
        if (sync) await player.syncNow();
      },
    },
  });
  const selected = await player.pollCommands(previous);
  expect(selected).toBe(fresh);
  const deadline = selected?.validUntil?.getTime() ?? null;
  expect(nextPollDelay(10_000, 1700, deadline)).toBe(300);
  sync = false;
  expect(await player.pollCommands(previous)).toBe(previous);
});

describe("waitForPoll", () => {
  it("leaves no wake listener behind when the poll interval wins", async () => {
    const wake = new EventTarget();
    const lifetime = new AbortController();
    for (let poll = 0; poll < 25; poll += 1) {
      await waitForPoll(wake, 1, lifetime.signal);
    }
    expect(getEventListeners(wake, "wake")).toHaveLength(0);
  });

  it("resolves on wake and removes its listener", async () => {
    const wake = new EventTarget();
    const lifetime = new AbortController();
    const waiting = waitForPoll(wake, 60_000, lifetime.signal);
    expect(getEventListeners(wake, "wake")).toHaveLength(1);
    wake.dispatchEvent(new Event("wake"));
    await waiting;
    expect(getEventListeners(wake, "wake")).toHaveLength(0);
  });

  it("rejects on abort and removes its listener", async () => {
    const wake = new EventTarget();
    const lifetime = new AbortController();
    const waiting = waitForPoll(wake, 60_000, lifetime.signal);
    lifetime.abort(new Error("player stopped"));
    await expect(waiting).rejects.toThrow("player stopped");
    expect(getEventListeners(wake, "wake")).toHaveLength(0);
  });
});
