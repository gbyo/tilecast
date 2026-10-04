import { QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { accountKeys, accountQueries } from "./account";
import { settingsKeys, settingsQueries } from "./settings";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Settings and Account query contracts", () => {
  it("shares organization data across consumers without mixing account preferences", async () => {
    let organizationRequests = 0;
    server.use(
      http.get("*/api/v1/settings", () => {
        organizationRequests++;
        return HttpResponse.json({
          data: {
            revision: 4,
            values: { "organization.timezone": "Europe/Madrid" },
          },
        });
      }),
      http.get("*/api/v1/me/preferences", () =>
        HttpResponse.json({
          data: { revision: 2, values: { "preference.appearance": "dark" } },
        }),
      ),
    );
    const client = new QueryClient();
    try {
      const document = await client.fetchQuery(settingsQueries.organization());
      expect(
        await client.fetchQuery({
          ...settingsQueries.organization(),
          staleTime: Infinity,
        }),
      ).toBe(document);
      await client.fetchQuery(accountQueries.preferences());
      expect(organizationRequests).toBe(1);
      await client.invalidateQueries({
        queryKey: settingsKeys.organization,
        refetchType: "none",
      });
      expect(
        client.getQueryState(settingsKeys.organization)?.isInvalidated,
      ).toBe(true);
      expect(client.getQueryState(accountKeys.preferences)?.isInvalidated).toBe(
        false,
      );
      expect(
        client.getQueryData(accountQueries.preferences().queryKey)?.values[
          "preference.appearance"
        ],
      ).toBe("dark");
    } finally {
      client.clear();
    }
  });

  for (const [name, path, options] of [
    ["organization", "/api/v1/settings", settingsQueries.organization],
    ["preferences", "/api/v1/me/preferences", accountQueries.preferences],
  ] as const) {
    it(`aborts ${name} requests through the typed HTTP boundary`, async () => {
      let started!: () => void;
      let aborted!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const requestAborted = new Promise<void>((resolve) => {
        aborted = resolve;
      });
      server.use(
        http.get(`*${path}`, async ({ request }) => {
          started();
          await new Promise<void>((resolve) =>
            request.signal.addEventListener(
              "abort",
              () => {
                aborted();
                resolve();
              },
              { once: true },
            ),
          );
          return HttpResponse.json({ data: { revision: 99, values: {} } });
        }),
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      try {
        const query = options();
        const pending = (
          name === "organization"
            ? client.fetchQuery(settingsQueries.organization())
            : client.fetchQuery(accountQueries.preferences())
        ).catch(() => undefined);
        await requestStarted;
        await client.cancelQueries({ queryKey: query.queryKey });
        await requestAborted;
        await pending;
        expect(client.getQueryData(query.queryKey)).toBeUndefined();
        expect(client.getQueryState(query.queryKey)?.fetchStatus).toBe("idle");
      } finally {
        client.clear();
      }
    });
  }
});
