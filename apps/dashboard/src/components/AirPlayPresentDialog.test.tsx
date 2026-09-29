// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { AirplaySession, ReliabilityStatus } from "../api/types";
import { AirPlayPresentDialog } from "./AirPlayPresentDialog";

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AirPlayPresentDialog
        open
        targetType="screen"
        targetId="screen-1"
        destinationName="Lobby"
        displayCount={1}
        csrfToken="csrf-token"
        audioDisplayName="Lobby TV"
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("AirPlay present dialog", () => {
  afterEach(cleanup);

  it("labels each session option with its visible field label", async () => {
    renderDialog();

    const duration = await screen.findByLabelText("Duration");
    const transport = screen.getByLabelText("Video transport");
    const audio = screen.getByLabelText("Audio display");

    expect(duration).toHaveAttribute("id", "airplay-duration");
    expect(transport).toHaveAttribute("id", "airplay-transport");
    expect(audio).toHaveAttribute("id", "airplay-audio-display");
    expect(
      screen.getByText(
        "Auto uses unicast for 1–4 displays and multicast only when validated.",
      ),
    ).toHaveAttribute("data-slot", "field-description");
    expect(screen.getByText("Primary audio: Lobby TV")).toHaveAttribute(
      "data-slot",
      "field-description",
    );
  });

  it("clears a previous AirPlay session when the target changes while open", async () => {
    const activeSession = {
      id: "session-a",
      status: "active",
      failedCount: 0,
      connectedCount: 1,
      readyCount: 1,
      screenCount: 1,
      receiverName: "Tilecast Receiver A",
      pin: "1234",
      videoProfile: "1080p30",
      transport: "unicast",
      audioMode: "gateway_only",
      expiresAt: "2099-01-01T00:00:00.000Z",
      screens: [
        {
          screenId: "screen-a",
          screenName: "Display A",
          state: "connected",
        },
      ],
    } as unknown as AirplaySession;
    const readyCapability = (
      externalPresentationSessionId?: string,
    ): ReliabilityStatus =>
      ({
        airplaySupported: true,
        airplayGroupSupported: true,
        airplayMaxProfile: "1080p30",
        airplayHardwareDecode: true,
        externalPresentationSessionId,
      }) as ReliabilityStatus;

    vi.spyOn(api, "airplaySession").mockResolvedValue(activeSession);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onClose = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <AirPlayPresentDialog
          open
          targetType="screen"
          targetId="screen-a"
          destinationName="Display A"
          displayCount={1}
          csrfToken="csrf-token"
          capabilities={[readyCapability("session-a")]}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Tilecast Receiver A")).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={client}>
        <AirPlayPresentDialog
          open
          targetType="screen"
          targetId="screen-b"
          destinationName="Display B"
          displayCount={1}
          csrfToken="csrf-token"
          capabilities={[readyCapability()]}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByText("Tilecast Receiver A")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Display B")).toBeInTheDocument();
  });
});
