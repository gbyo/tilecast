// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { H264StreamOptions } from "../live-stream/h264Stream";
import { LiveStreamDialog } from "./LiveStreamDialog";

// jsdom has no WebCodecs, so the default answer is MJPEG only. A test that
// needs an H.264-capable browser sets `offered` and drives the stream mock.
const webCodecs = vi.hoisted(() => ({
  offered: null as string[] | null,
  streams: [] as { options: H264StreamOptions; stopped: boolean }[],
}));
vi.mock("../live-stream/h264Support", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../live-stream/h264Support")>();
  return {
    ...actual,
    acceptedProfiles: () =>
      Promise.resolve(webCodecs.offered ?? ["mjpeg-540p10", "mjpeg-360p8"]),
  };
});
vi.mock("../live-stream/h264Stream", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../live-stream/h264Stream")>();
  return {
    ...actual,
    startH264Stream: (options: H264StreamOptions) => {
      const stream = { options, stopped: false };
      webCodecs.streams.push(stream);
      return () => {
        stream.stopped = true;
      };
    },
  };
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

afterEach(() => {
  // Testing Library's auto-cleanup does not hook this file's explicitly
  // imported hooks, so unmount here: a dialog left open leaks its stream
  // image into the next test's queries.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  webCodecs.offered = null;
  webCodecs.streams = [];
});

describe("LiveStreamDialog", () => {
  it("starts, presents, and explicitly ends an ephemeral session", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "session-1",
              screenId: "screen-1",
              active: true,
              expiresAt: "2026-07-30T12:00:15Z",
              frameIntervalMillis: 125,
              maxWidth: 640,
              maxHeight: 360,
              maxFrameBytes: 102400,
            },
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));
    const onClose = vi.fn();
    const view = render(
      <LiveStreamDialog
        open
        screenId="screen-1"
        screenName="Lobby"
        csrfToken="csrf"
        onClose={onClose}
      />,
    );

    const image = await screen.findByAltText("Live Tilecast output from Lobby");
    expect(image.getAttribute("src")).toBe(
      "/api/v1/screens/screen-1/live-stream/session-1/mjpeg",
    );
    fireEvent.load(image);
    expect(screen.getByText("Live")).toBeTruthy();

    expect(
      screen.getByText(/never saved to snapshots, live preview/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop watching" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(
      <LiveStreamDialog
        open={false}
        screenId="screen-1"
        screenName="Lobby"
        csrfToken="csrf"
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    );
  });

  it("automatically reconnects after a transport error", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "session-auto",
              screenId: "screen-1",
              active: true,
              expiresAt: "2026-07-30T12:00:15Z",
              frameIntervalMillis: 125,
              maxWidth: 640,
              maxHeight: 360,
              maxFrameBytes: 102400,
              frameSequence: 1,
              lastFrameAt: new Date().toISOString(),
            },
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));

    render(
      <LiveStreamDialog
        open
        screenId="screen-1"
        screenName="Lobby"
        csrfToken="csrf"
        onClose={() => undefined}
      />,
    );

    const image = await screen.findByAltText("Live Tilecast output from Lobby");
    vi.useFakeTimers();
    fireEvent.error(image);
    expect(screen.queryByText("Stream unavailable")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
    });
    expect(
      screen
        .getByAltText("Live Tilecast output from Lobby")
        .getAttribute("src"),
    ).toBe("/api/v1/screens/screen-1/live-stream/session-auto/mjpeg?retry=1");
  });

  it("does not steal a replaced session", async () => {
    const session = {
      id: "session-old",
      screenId: "screen-1",
      active: true,
      expiresAt: "2026-07-30T12:00:15Z",
      frameIntervalMillis: 125,
      maxWidth: 640,
      maxHeight: 360,
      maxFrameBytes: 102400,
      frameSequence: 1,
      lastFrameAt: new Date().toISOString(),
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: session }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "live_stream_replaced",
              message: "Another viewer replaced this live stream session.",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));

    // Fake timers start before mount: the renewal timeout is scheduled
    // when the session installs, and post-mount faking cannot move it.
    vi.useFakeTimers();
    render(
      <LiveStreamDialog
        open
        screenId="screen-1"
        screenName="Lobby"
        csrfToken="csrf"
        onClose={() => undefined}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByAltText("Live Tilecast output from Lobby")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByText("Stream unavailable")).toBeTruthy();
    expect(
      screen.getByText("Another viewer started Watch Live for this screen."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry stream" })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recreates an expired session", async () => {
    const session = (id: string) => ({
      id,
      screenId: "screen-1",
      active: true,
      expiresAt: "2026-07-30T12:00:15Z",
      frameIntervalMillis: 125,
      maxWidth: 640,
      maxHeight: 360,
      maxFrameBytes: 102400,
      frameSequence: 0,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: session("session-1") }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "live_stream_not_found",
              message: "That live stream is no longer active.",
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: session("session-2") }), {
          status: 201,
        }),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));

    // Fake timers start before mount: the renewal timeout is scheduled
    // when the session installs, and post-mount faking cannot move it.
    vi.useFakeTimers();
    render(
      <LiveStreamDialog
        open
        screenId="screen-1"
        screenName="Lobby"
        csrfToken="csrf"
        onClose={() => undefined}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const firstImage = screen.getByAltText("Live Tilecast output from Lobby");
    expect(firstImage.getAttribute("src")).toContain("/session-1/mjpeg");

    // The renewal reports the session gone; the single immediate recovery
    // fires after its first backoff.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(
      screen
        .getByAltText("Live Tilecast output from Lobby")
        .getAttribute("src"),
    ).toContain("/session-2/mjpeg");
    expect(screen.queryByText("Stream unavailable")).toBeNull();
  });

  it("offers only MJPEG without WebCodecs and treats an older server as MJPEG", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "session-old-server",
              screenId: "screen-1",
              active: true,
              expiresAt: "2026-07-30T12:00:15Z",
              frameIntervalMillis: 100,
              maxWidth: 960,
              maxHeight: 540,
              maxFrameBytes: 102400,
            },
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(
      <LiveStreamDialog
        open
        screenId="screen-1"
        screenName="Lobby"
        csrfToken="csrf"
        onClose={() => undefined}
      />,
    );
    const image = await screen.findByAltText("Live Tilecast output from Lobby");
    expect(image.tagName).toBe("IMG");
    const start = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(start?.body as string)).toEqual({
      acceptProfiles: ["mjpeg-540p10", "mjpeg-360p8"],
    });
    expect(screen.getByText("10 FPS · 960×540 · MJPEG")).toBeTruthy();
  });

  it("negotiates H.264, plays it, and falls back to MJPEG when decoding fails", async () => {
    webCodecs.offered = [
      "h264-720p15",
      "h264-540p15",
      "h264-540p10",
      "mjpeg-540p10",
      "mjpeg-360p8",
    ];
    const base = {
      screenId: "screen-1",
      active: true,
      expiresAt: "2026-07-30T12:00:15Z",
      maxFrameBytes: 524288,
      frameSequence: 0,
      profileGeneration: 0,
    };
    const negotiating = {
      ...base,
      id: "session-h264",
      transport: "mjpeg",
      frameIntervalMillis: 125,
      maxWidth: 640,
      maxHeight: 360,
    };
    const selected = {
      ...negotiating,
      profile: "h264-720p15",
      transport: "h264",
      codec: "avc1.42e01f",
      frameIntervalMillis: 67,
      maxWidth: 1280,
      maxHeight: 720,
      targetBitrate: 1500000,
    };
    const fallback = {
      ...base,
      id: "session-mjpeg",
      profile: "mjpeg-540p10",
      transport: "mjpeg",
      frameIntervalMillis: 100,
      maxWidth: 960,
      maxHeight: 540,
      maxFrameBytes: 102400,
    };
    const requests: { method: string; url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const method = init?.method ?? "GET";
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(href, "http://localhost").pathname;
      const text = typeof init?.body === "string" ? init.body : "";
      requests.push({ method, url, body: text ? JSON.parse(text) : null });
      if (method === "DELETE")
        return Promise.resolve(new Response(null, { status: 204 }));
      if (url.endsWith("/renew")) {
        const id = url.split("/")[6];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: id === "session-h264" ? selected : fallback,
            }),
            { status: 200 },
          ),
        );
      }
      const starts = requests.filter(
        (entry) => entry.method === "POST" && !entry.url.endsWith("/renew"),
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: starts.length === 1 ? negotiating : fallback,
          }),
          { status: 201 },
        ),
      );
    });

    render(
      <LiveStreamDialog
        open
        screenId="screen-1"
        screenName="Lobby"
        csrfToken="csrf"
        onClose={() => undefined}
      />,
    );
    expect(
      await screen.findByText(/Choosing the best stream format/),
    ).toBeTruthy();
    expect(requests[0]?.body).toEqual({ acceptProfiles: webCodecs.offered });

    // The Player chose H.264 720p15: the viewer renders a canvas.
    const canvas = await screen.findByRole(
      "img",
      { name: "Live Tilecast output from Lobby" },
      { timeout: 3000 },
    );
    expect(canvas.tagName).toBe("CANVAS");
    expect(webCodecs.streams).toHaveLength(1);
    const stream = webCodecs.streams[0]!;
    expect(stream.options.url).toBe(
      "/api/v1/screens/screen-1/live-stream/session-h264/h264",
    );
    expect(stream.options.sessionId).toBe("session-h264");
    act(() => stream.options.callbacks.onFirstFrame());
    expect(screen.getByText("Live")).toBeTruthy();
    expect(
      screen.getByText("15 FPS · 1280×720 · H.264 (about 1.5 Mbit/s)"),
    ).toBeTruthy();

    // Decoding fails for good: the lease restarts offering MJPEG only.
    act(() => stream.options.callbacks.onDecoderFailed());
    const image = await waitFor(
      () => {
        const element = screen.getByAltText("Live Tilecast output from Lobby");
        expect(element.tagName).toBe("IMG");
        return element;
      },
      { timeout: 3000 },
    );
    expect(image.getAttribute("src")).toBe(
      "/api/v1/screens/screen-1/live-stream/session-mjpeg/mjpeg",
    );
    expect(stream.stopped).toBe(true);
    await waitFor(() =>
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: "DELETE",
          url: "/api/v1/screens/screen-1/live-stream/session-h264",
        }),
      ),
    );
    const restart = requests.filter(
      (entry) => entry.method === "POST" && !entry.url.endsWith("/renew"),
    )[1];
    expect(restart?.body).toEqual({
      acceptProfiles: ["mjpeg-540p10", "mjpeg-360p8"],
    });
  });
});
