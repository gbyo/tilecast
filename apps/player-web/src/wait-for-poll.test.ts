import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForPoll } from "./player";

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
