/**
 * Narrow HTTP-boundary coverage for the typed transport: envelopes,
 * 204, malformed bodies, network failure, abort, and CSRF-bearing
 * mutations. This is not a fake Tilecast backend: each test states one
 * wire behavior of the transport itself.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { apiDelete, apiGet, apiPost } from "./transport";
import { ApiError } from "./errors";

const server = setupServer(
  http.get("*/api/v1/screens", () =>
    HttpResponse.json({ data: { items: [], total: 0 } }),
  ),
  http.delete(
    "*/api/v1/integration-tokens/gone",
    () => new HttpResponse(null, { status: 204 }),
  ),
  http.post("*/api/v1/notifications/test", ({ request }) => {
    if (request.headers.get("X-CSRF-Token") !== "csrf-token") {
      return HttpResponse.json(
        { error: { code: "csrf_required", message: "CSRF token required." } },
        { status: 403 },
      );
    }
    return HttpResponse.json({ data: { sentTo: "ops@example.com" } });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("typed transport boundary", () => {
  it("unwraps the standard success envelope", async () => {
    await expect(apiGet("/api/v1/screens")).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  it("maps the typed error envelope to ApiError", async () => {
    server.use(
      http.get("*/api/v1/screens", () =>
        HttpResponse.json(
          { error: { code: "screen_unknown", message: "No such screen." } },
          { status: 404 },
        ),
      ),
    );
    const failure = apiGet("/api/v1/screens");
    await expect(failure).rejects.toMatchObject({
      status: 404,
      code: "screen_unknown",
      message: "No such screen.",
    });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
  });

  it("resolves undefined for 204 responses", async () => {
    await expect(
      apiDelete("/api/v1/integration-tokens/{id}", {
        params: { path: { id: "gone" } },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects malformed non-JSON responses", async () => {
    server.use(
      http.get("*/api/v1/screens", () =>
        HttpResponse.text("proxy gateway page"),
      ),
    );
    await expect(apiGet("/api/v1/screens")).rejects.toMatchObject({
      code: "malformed_response",
    });
  });

  it("rejects non-JSON error bodies without losing the status", async () => {
    server.use(
      http.get("*/api/v1/screens", () =>
        HttpResponse.text("bad gateway", { status: 502 }),
      ),
    );
    await expect(apiGet("/api/v1/screens")).rejects.toMatchObject({
      status: 502,
    });
  });

  it("resolves undefined for a 200 with an empty body", async () => {
    server.use(http.get("*/api/v1/screens", () => new HttpResponse(null)));
    await expect(apiGet("/api/v1/screens")).resolves.toBeUndefined();
  });

  it("resolves undefined when a 200 body carries no data envelope", async () => {
    server.use(
      http.get("*/api/v1/screens", () => HttpResponse.json({ items: [] })),
    );
    await expect(apiGet("/api/v1/screens")).resolves.toBeUndefined();
  });

  it("attaches the caller-provided CSRF token on mutations", async () => {
    await expect(
      apiPost("/api/v1/notifications/test", {
        csrfToken: "csrf-token",
      }),
    ).resolves.toEqual({ sentTo: "ops@example.com" });
    await expect(apiPost("/api/v1/notifications/test")).rejects.toMatchObject({
      status: 403,
      code: "csrf_required",
    });
  });

  it("lets aborts propagate as abort errors, not ApiError", async () => {
    server.use(
      http.get("*/api/v1/screens", async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return HttpResponse.json({ data: { items: [] } });
      }),
    );
    const controller = new AbortController();
    const pending = apiGet("/api/v1/screens", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => (error as Error).name === "AbortError",
    );
  });

  it("maps network failure to ApiError without inventing a status", async () => {
    server.use(http.get("*/api/v1/screens", () => HttpResponse.error()));
    await expect(apiGet("/api/v1/screens")).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });
  });
});
