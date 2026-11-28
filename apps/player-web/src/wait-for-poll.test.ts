import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { nextPollDelay, waitForPoll } from "./player";

it("wakes at the server's next boundary before the regular poll", () => {
  expect(nextPollDelay(10_000, 1700, 2000)).toBe(300);
  expect(nextPollDelay(10_000, 1999, 2000)).toBe(1);
  expect(nextPollDelay(10_000, 1700, 20_000)).toBe(10_000);
  expect(nextPollDelay(10_000, 1700, null)).toBe(10_000);
  expect(nextPollDelay(10_000, 2100, 2000)).toBeGreaterThan(0);
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
