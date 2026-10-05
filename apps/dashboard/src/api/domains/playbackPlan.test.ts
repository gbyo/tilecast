import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { getScreenPlaybackPlan, type PlaybackPlan } from "./playbackPlan";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("requests server time by omission and preserves structured current evidence", async () => {
  const plan: PlaybackPlan = {
    screenId: "cafeteria",
    at: "2026-10-02T16:15:00Z",
    evaluatedAt: "2026-10-02T16:15:00Z",
    basis: "current_configuration",
    current: {
      candidates: [],
      synchronization: { status: "not_reported", manifestVersion: 7 },
      capabilities: { status: "not_applicable", reason: "no_selected_content" },
    },
  };
  server.use(
    http.get("*/api/v1/screens/cafeteria/playback-plan", ({ request }) => {
      expect(new URL(request.url).searchParams.has("at")).toBe(false);
      return HttpResponse.json({ data: plan });
    }),
  );
  await expect(getScreenPlaybackPlan("cafeteria")).resolves.toEqual(plan);
});

it("passes the exact historical instant and retains an evidence gap", async () => {
  const at = "2026-10-01T12:15:00.123456-04:00";
  server.use(
    http.get("*/api/v1/screens/cafeteria/playback-plan", ({ request }) => {
      expect(new URL(request.url).searchParams.get("at")).toBe(at);
      return HttpResponse.json({
        data: {
          screenId: "cafeteria",
          at: "2026-10-01T16:15:00.123456Z",
          evaluatedAt: "2026-10-02T16:15:00Z",
          basis: "historical_expectation_unavailable",
          historical: {},
        } satisfies PlaybackPlan,
      });
    }),
  );
  const plan = await getScreenPlaybackPlan("cafeteria", { at });
  expect(plan.basis).toBe("historical_expectation_unavailable");
  expect(plan.current).toBeUndefined();
  expect(plan.historical?.expectation).toBeUndefined();
});

it("preserves machine-readable overlap errors through typed transport", async () => {
  server.use(
    http.get("*/api/v1/screens/cafeteria/playback-plan", () =>
      HttpResponse.json(
        {
          error: {
            code: "playback_expectation_ambiguous",
            // i18n-ignore: simulated API response, never displayed by this adapter.
            message: "Recorded expectations overlap.",
          },
        },
        { status: 409 },
      ),
    ),
  );
  await expect(getScreenPlaybackPlan("cafeteria")).rejects.toMatchObject({
    status: 409,
    code: "playback_expectation_ambiguous",
  });
});

it("passes cancellation to the transport", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    getScreenPlaybackPlan("cafeteria", { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
