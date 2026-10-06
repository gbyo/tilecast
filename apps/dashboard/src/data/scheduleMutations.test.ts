import { MutationObserver, QueryClient } from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ScheduleInput } from "../api/types";
import { scheduleKeys, scheduleMutations } from "./schedules";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const input: ScheduleInput = {
  name: "Morning",
  description: "",
  type: "weekly",
  timezone: "UTC",
  priority: 1,
  enabled: true,
  daysOfWeek: [1],
  targets: [{ type: "screen", id: "lobby" }],
};

function populate(client: QueryClient) {
  const keys = [
    scheduleKeys.all,
    scheduleKeys.list(),
    scheduleKeys.pages(),
    scheduleKeys.detail("morning"),
    scheduleKeys.defaults(),
    scheduleKeys.preview("lobby", "2026-10-05T09:00:00Z", input),
    scheduleKeys.preflight("morning", "signature"),
  ];
  for (const key of keys) client.setQueryData(key, {});
  client.setQueryData(["playlists"], {});
  return keys;
}

describe("Schedule mutation contracts", () => {
  it.each([undefined, "morning"])(
    "saves with typed transport and invalidates all Schedule consumers (id=%s)",
    async (id) => {
      server.use(
        (id ? http.patch : http.post)(
          id ? "*/api/v1/schedules/morning" : "*/api/v1/schedules",
          async ({ request }) => {
            expect(request.headers.get("X-CSRF-Token")).toBe("test-csrf");
            expect(await request.json()).toEqual(input);
            return HttpResponse.json({ data: { ...input, id: "morning" } });
          },
        ),
      );
      const client = new QueryClient();
      const keys = populate(client);
      try {
        const mutation = client
          .getMutationCache()
          .build(client, scheduleMutations.save(client, "test-csrf", id));
        expect((await mutation.execute(input)).id).toBe("morning");
        for (const key of keys)
          expect(client.getQueryState(key)?.isInvalidated).toBe(true);
        expect(client.getQueryState(["playlists"])?.isInvalidated).toBe(false);
      } finally {
        client.clear();
      }
    },
  );

  it("invalidates after deletion and preserves cache on a rejected request", async () => {
    let reject = true;
    server.use(
      http.delete("*/api/v1/schedules/morning", ({ request }) => {
        expect(request.headers.get("X-CSRF-Token")).toBe("test-csrf");
        return reject
          ? HttpResponse.json(
              { error: { code: "forbidden", message: "Forbidden." } },
              { status: 403 },
            )
          : new HttpResponse(null, { status: 204 });
      }),
    );
    const client = new QueryClient();
    const keys = populate(client);
    try {
      const options = scheduleMutations.remove(client, "test-csrf", "morning");
      await expect(
        client.getMutationCache().build(client, options).execute(undefined),
      ).rejects.toMatchObject({ code: "forbidden" });
      for (const key of keys)
        expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      reject = false;
      await client.getMutationCache().build(client, options).execute(undefined);
      // The deleted schedule's own detail is dropped, not refetched into a 404;
      // everything else that could mention it is invalidated.
      expect(
        client.getQueryState(scheduleKeys.detail("morning")),
      ).toBeUndefined();
      for (const key of keys.filter(
        (key) => key !== keys[3], // the detail entry
      ))
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("deletes any row by id, with the CSRF token, and invalidates every Schedule consumer", async () => {
    const deleted: string[] = [];
    server.use(
      http.delete("*/api/v1/schedules/:id", ({ request, params }) => {
        expect(request.headers.get("X-CSRF-Token")).toBe("test-csrf");
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = new QueryClient();
    const keys = populate(client);
    try {
      const options = scheduleMutations.removeById(client, "test-csrf");
      await client.getMutationCache().build(client, options).execute("lunch");
      expect(deleted).toEqual(["lunch"]);
      for (const key of keys)
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("retains domain invalidation after the UI observer leaves, without stale feedback", async () => {
    let finish!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    server.use(
      http.post("*/api/v1/schedules", async () => {
        started();
        await pending;
        return HttpResponse.json({ data: { ...input, id: "morning" } });
      }),
    );
    const client = new QueryClient();
    const keys = populate(client);
    const observer = new MutationObserver(
      client,
      scheduleMutations.save(client, "test-csrf"),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    const feedback = vi.fn();
    try {
      const result = observer.mutate(input, { onSuccess: feedback });
      await requested;
      unsubscribe();
      finish();
      await result;
      expect(feedback).not.toHaveBeenCalled();
      for (const key of keys)
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      finish();
      unsubscribe();
      client.clear();
    }
  });
});
