// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveStreamDialog } from "./LiveStreamDialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    ).toBe(
      "/api/v1/screens/screen-1/live-stream/session-auto/mjpeg?retry=1",
    );
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

    render(
      <LiveStreamDialog
        open
        screenId="screen-1"
        screenName="Lobby"
        csrfToken="csrf"
        onClose={() => undefined}
      />,
    );
    await screen.findByAltText("Live Tilecast output from Lobby");

    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Stream unavailable")).toBeTruthy();
    expect(
      screen.getByText("Another viewer started Watch Live for this screen."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry stream" })).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(12_000);
      await Promise.resolve();
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

    render(
      <LiveStreamDialog
        open
        screenId="screen-1"
        screenName="Lobby"
        csrfToken="csrf"
        onClose={() => undefined}
      />,
    );
    const firstImage = await screen.findByAltText(
      "Live Tilecast output from Lobby",
    );
    expect(firstImage.getAttribute("src")).toContain("/session-1/mjpeg");

    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen
        .getByAltText("Live Tilecast output from Lobby")
        .getAttribute("src"),
    ).toContain("/session-2/mjpeg");
    expect(screen.queryByText("Stream unavailable")).toBeNull();
  });
});
