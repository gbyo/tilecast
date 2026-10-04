// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import {
  presentationLabel,
  ScreenActivityPanel,
  ScreenActivitySummary,
  toScreenActivity,
} from "./ScreenActivityPanel";

const proof = {
  id: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-07-26T09:00:00.000Z",
  screenId: "22222222-2222-4222-8222-222222222222",
  screenName: "Lobby",
  presentationName: "Lobby loop",
  contentName: "Welcome video",
  result: "completed",
  sessionType: "presentation",
  details: {},
} as const;

/** The response exactly as the Server serializes it (screenActivityData). */
const serverResponse = {
  screenId: proof.screenId,
  currentPresentation: proof,
  recentProofOfPlay: [{ ...proof, id: "33333333-3333-4333-8333-333333333333" }],
  recentEvents: [],
  playbackGaps: 2,
  lastHealthyPlayback: "2026-07-26T09:30:00.000Z",
  lastSuccessfulManifestActivation: "2026-07-26T08:00:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const data = url.includes("/timeline")
        ? {
            range: { from: "", to: "" },
            status: { health: "healthy", healthReason: "playing" },
            entries: [],
          }
        : serverResponse;
      return Promise.resolve(
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScreenActivityPanel screenId={proof.screenId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScreenActivityPanel", () => {
  it("reads the response fields the Server actually sends", async () => {
    renderPanel();

    const presentation = (await screen.findByText("Current presentation"))
      .parentElement as HTMLElement;
    // The current presentation arrives as a proof record, not a string.
    expect(presentation).toHaveTextContent("Lobby loop");

    const activation = screen.getByText("Last manifest activation")
      .parentElement as HTMLElement;
    expect(activation).not.toHaveTextContent("Not reported");

    const proofList = screen.getByRole("region", {
      name: "Recent proof of play",
    });
    expect(within(proofList).getAllByRole("listitem")).toHaveLength(1);
    expect(proofList).toHaveTextContent("Welcome video");
    expect(proofList).not.toHaveTextContent(
      "No proof of play has been reported.",
    );
  });
});

describe("ScreenActivitySummary", () => {
  it("shows compact recent activity and opens the full Activity workspace", async () => {
    const onOpen = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ScreenActivitySummary screenId={proof.screenId} onOpen={onOpen} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Recent technical events")).toBeTruthy();
    screen.getByRole("button", { name: "Activity" }).click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("toScreenActivity", () => {
  it("names the presentation from its proof record", () => {
    expect(presentationLabel(proof)).toBe("Lobby loop");
    expect(presentationLabel({ ...proof, presentationName: undefined })).toBe(
      "Welcome video",
    );
    expect(presentationLabel(undefined)).toBeUndefined();
  });

  it("maps the Server's field names to the panel view", () => {
    const view = toScreenActivity(serverResponse);
    expect(view.recentProof).toHaveLength(1);
    expect(view.currentPresentation).toBe("Lobby loop");
    expect(view.lastSuccessfulActivation).toBe("2026-07-26T08:00:00.000Z");
  });
});
