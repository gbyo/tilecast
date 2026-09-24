// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
