import { describe, expect, it } from "vitest";
import { PlayerAPI } from "../api";
import { flushActivity } from "./uploader";
import { recorderHarness } from "../test-support/recorder-harness";

function server(
  behaviour: (
    events: { id: string; sequence: number }[],
  ) => Response | Promise<Response>,
) {
  const batches: { id: string; sequence: number }[][] = [];
  const transport = (async (_: RequestInfo | URL, init?: RequestInit) => {
    const events = (
      JSON.parse(String(init?.body)) as {
        events: { id: string; sequence: number }[];
      }
    ).events;
    batches.push(events);
    return behaviour(events);
  }) as typeof fetch;
  return { api: new PlayerAPI(transport), batches };
}
const accept = (events: { id: string; sequence: number }[]) =>
  new Response(
    JSON.stringify({
      data: {
        accepted: events.length,
        duplicates: 0,
        highestSequence: Math.max(...events.map((event) => event.sequence)),
        acknowledgedEventIds: events.map((event) => event.id),
      },
    }),
    { status: 202 },
  );

async function queued(count: number) {
  const h = await recorderHarness();
  for (let index = 0; index < count; index++)
    h.recorder.record({
      eventType: "content.started",
      activitySessionId: `s${index}`,
    });
  await h.recorder.idle();
  return h;
}

describe("Activity upload", () => {
  it("holds every event while the Host is unconfirmed, then sends them in order", async () => {
    const h = await queued(3);
    const remote = server(accept);
    let confirmed = false;
    expect(await flushActivity(remote.api, h.outbox, () => confirmed)).toEqual({
      state: "blocked",
    });
    expect(remote.batches).toHaveLength(0);
    expect(await h.outbox.count()).toBe(3);
    confirmed = true;
    expect(
      (await flushActivity(remote.api, h.outbox, () => confirmed)).state,
    ).toBe("sent");
    expect(remote.batches[0]!.map((event) => event.sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(await h.outbox.count()).toBe(0);
  });

  it("keeps the queue through an outage and retries with the same event IDs", async () => {
    const h = await queued(2);
    let down = true;
    const remote = server((events) =>
      down ? new Response("bad gateway", { status: 502 }) : accept(events),
    );
    expect((await flushActivity(remote.api, h.outbox, () => true)).state).toBe(
      "deferred",
    );
    expect(await h.outbox.count()).toBe(2);
    down = false;
    await flushActivity(remote.api, h.outbox, () => true);
    expect(remote.batches[1]!.map((event) => event.id)).toEqual(
      remote.batches[0]!.map((event) => event.id),
    );
    expect(await h.outbox.count()).toBe(0);
  });

  it("sends no more than the server accepts in one batch", async () => {
    const h = await queued(450);
    const remote = server(accept);
    await flushActivity(remote.api, h.outbox, () => true);
    expect(remote.batches.map((batch) => batch.length)).toEqual([200, 200, 50]);
  });

  it("does not remove an event the server did not acknowledge", async () => {
    const h = await queued(3);
    const remote = server(
      (events) =>
        new Response(
          JSON.stringify({
            data: {
              accepted: 1,
              duplicates: 0,
              highestSequence: 1,
              acknowledgedEventIds: [events[0]!.id],
            },
          }),
          { status: 202 },
        ),
    );
    await flushActivity(remote.api, h.outbox, () => false).catch(
      () => undefined,
    );
    let calls = 0;
    await flushActivity(remote.api, h.outbox, () => ++calls === 1);
    expect(await h.outbox.count()).toBe(2);
  });

  it("isolates and drops one event the server refuses, keeping the rest", async () => {
    const h = await queued(4);
    const remote = server((events) => {
      if (events.some((event) => event.sequence === 3))
        return new Response(
          JSON.stringify({
            error: { code: "player_activity_event_invalid", message: "x" },
          }),
          { status: 422 },
        );
      return accept(events);
    });
    await flushActivity(remote.api, h.outbox, () => true);
    expect(await h.outbox.count()).toBe(0);
    // The refused event was tried alone and not sent again.
    const lone = remote.batches.filter(
      (batch) => batch.length === 1 && batch[0]!.sequence === 3,
    );
    expect(lone).toHaveLength(1);
  });

  it("does not drop events for an authorization failure", async () => {
    const h = await queued(2);
    const remote = server(
      () =>
        new Response(
          JSON.stringify({ error: { code: "browser_session_required" } }),
          { status: 401 },
        ),
    );
    const result = await flushActivity(remote.api, h.outbox, () => true);
    expect(result.state).toBe("deferred");
    expect(await h.outbox.count()).toBe(2);
  });
});
