// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    fireEvent.error(image);
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.getByText("Live preview unavailable")).toBeTruthy();
    expect(screen.getByText("Live preview connection ended.")).toBeTruthy();

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
});
