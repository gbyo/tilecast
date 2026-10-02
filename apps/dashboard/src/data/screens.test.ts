import { QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { screenKeys, screenQueries } from "./screens";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Screen query contracts", () => {
  it("reuses prefetched detail data through the typed HTTP boundary", async () => {
    let requests = 0;
    server.use(
      http.get("*/api/v1/screens/lobby", () => {
        requests++;
        return HttpResponse.json({
          data: { id: "lobby", name: "Lobby", playerFamily: "edge" },
        });
      }),
    );
    const client = new QueryClient();
    try {
      await client.prefetchQuery(screenQueries.detail("lobby"));
      const cached = client.getQueryData(
        screenQueries.detail("lobby").queryKey,
      );
      expect(cached?.name).toBe("Lobby");
      expect(cached?.playerFamily).toBe("edge");
      const detail = await client.fetchQuery({
        ...screenQueries.detail("lobby"),
        staleTime: Infinity,
      });
      expect(detail).toBe(cached);
      expect(requests).toBe(1);
    } finally {
      client.clear();
    }
  });

  it("invalidates one Screen's descendants without invalidating the fleet or another Screen", async () => {
    const client = new QueryClient();
    const keys = [
      screenKeys.list(),
      screenKeys.detail("lobby"),
      screenKeys.assignment("lobby"),
      screenKeys.commands("lobby"),
      screenKeys.reliability("lobby"),
      screenKeys.playerHistory("lobby"),
      screenKeys.detail("library"),
      screenKeys.pendingPairings(),
      screenKeys.preview("lobby"),
    ];
    try {
      for (const key of keys) client.setQueryData(key, {});
      await client.invalidateQueries({ queryKey: screenKeys.detail("lobby") });
      for (const key of keys) {
        expect(client.getQueryState(key)?.isInvalidated).toBe(
          key[1] === "lobby" && key[0] === "screens",
        );
      }
      await client.invalidateQueries({ queryKey: screenKeys.all });
      for (const key of keys) {
        expect(client.getQueryState(key)?.isInvalidated).toBe(
          key[0] === "screens",
        );
      }
    } finally {
      client.clear();
    }
  });
});
