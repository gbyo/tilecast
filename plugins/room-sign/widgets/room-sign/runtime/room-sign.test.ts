import { afterEach, describe, expect, it } from "vitest";
import {
  createManualClock,
  createTestContext,
  fixtureResources,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import fixture from "../fixtures/default.json";
import free from "../fixtures/free.json";
import stale from "../fixtures/stale.json";
import widget from "./index.ts";
import {
  nextRoomBoundary,
  parseRoomSignConfig,
  roomState,
  type RoomMeeting,
} from "./room-sign.ts";

afterEach(() => document.body.replaceChildren());

const meeting = (id: string, start: string, end: string): RoomMeeting => ({
  id,
  title: id,
  startMs: Date.parse(start),
  endMs: Date.parse(end),
});

describe("room state", () => {
  const meetings = [
    meeting("a", "2026-09-28T14:00:00Z", "2026-09-28T15:00:00Z"),
    meeting("b", "2026-09-28T16:00:00Z", "2026-09-28T16:30:00Z"),
  ];
  it("finds the current and next meeting and the next boundary", () => {
    expect(
      roomState(meetings, Date.parse("2026-09-28T14:30:00Z")),
    ).toMatchObject({ current: { id: "a" }, next: { id: "b" } });
    expect(
      roomState(meetings, Date.parse("2026-09-28T15:00:00Z")),
    ).toMatchObject({ current: null, next: { id: "b" } });
    expect(roomState(meetings, Date.parse("2026-09-28T17:00:00Z"))).toEqual({
      current: null,
      next: null,
    });
    expect(nextRoomBoundary(meetings, Date.parse("2026-09-28T14:30:00Z"))).toBe(
      Date.parse("2026-09-28T15:00:00Z"),
    );
  });
  it("bounds the configuration", () => {
    const parsed = parseRoomSignConfig({
      roomName: "x".repeat(200),
      freeLabel: "",
    });
    expect(parsed.ok && parsed.config.roomName.length).toBe(80);
    expect(parsed.ok && parsed.config.freeLabel).toBe("Available");
    expect(parseRoomSignConfig(null).ok).toBe(false);
  });
});

function mount(
  input: { configuration: unknown; documents?: unknown },
  at: string,
) {
  const clock = createManualClock();
  clock.setNow(Date.parse(at));
  return mountForTest(widget, {
    config: input.configuration,
    resources: fixtureResources({ documents: input.documents as never }),
    context: createTestContext({
      clock,
      timeZone: "UTC",
      locale: "en-US",
      hourCycle: "h23",
    }),
  });
}

describe("room sign", () => {
  it("shows the meeting on now with the corrected clock", async () => {
    const test = mount(fixture, "2026-09-28T14:20:00Z");
    await (test.element as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    const text = test.element!.shadowRoot!.textContent ?? "";
    expect(text).toContain("In use");
    expect(text).toContain("Budget review");
    expect(text).toContain("Hiring sync");
    expect(text).not.toContain("out of date");
    expect(test.states.at(-1)).toEqual({ state: "ready" });
    test.dispose();
  });
  it("is free and ready without meetings", async () => {
    const test = mount(free, "2026-09-28T14:20:00Z");
    await (test.element as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(test.element!.shadowRoot!.textContent).toContain("Available");
    expect(test.states.at(-1)).toEqual({ state: "ready" });
    test.dispose();
  });
  it("says a stale schedule may be out of date", async () => {
    const test = mount(stale, "2026-09-28T15:20:00Z");
    await (test.element as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    const text = test.element!.shadowRoot!.textContent ?? "";
    expect(text).toContain("Available");
    expect(text).toContain("out of date");
    test.dispose();
  });
});
