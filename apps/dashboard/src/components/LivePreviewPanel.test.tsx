// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LivePreviewPanel } from "./LivePreviewPanel";

const { screenMock, metadataMock, renewMock } = vi.hoisted(() => ({
  screenMock: vi.fn(),
  metadataMock: vi.fn(),
  renewMock: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: { screen: screenMock },
}));

vi.mock("../api/previews", () => ({
  previewApi: {
    metadata: metadataMock,
    renew: renewMock,
    imageUrl: (screenId: string, version: string) =>
      `/api/v1/screens/${screenId}/preview/image?v=${encodeURIComponent(version)}`,
  },
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf" } }),
}));

vi.mock("./LiveStreamDialog", () => ({
  LiveStreamDialog: () => null,
}));

const preview = {
  screenId: "screen-1",
  status: "available" as const,
  imageAvailable: true,
  capturedAt: "2026-09-06T03:50:00.000Z",
  updatedAt: "capture-1",
  playerVersion: "0.17.0",
  width: 640,
  height: 360,
  fileSize: 1024,
};

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <LivePreviewPanel screenId="screen-1" />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

beforeEach(() => {
  screenMock.mockResolvedValue({
    id: "screen-1",
    name: "Lobby",
    status: "online",
    playerVersion: "0.17.0",
  });
  metadataMock.mockResolvedValue(preview);
  renewMock.mockResolvedValue({
    active: true,
    captureIntervalSeconds: 20,
    captureNow: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LivePreviewPanel", () => {
  it("shows an explicit image error and recovers for a newer capture", async () => {
    const { client } = renderPanel();

    const image = await screen.findByAltText("Current Tilecast output for Lobby");
    fireEvent.error(image);

    expect(screen.queryByAltText("Current Tilecast output for Lobby")).toBeNull();
    expect(screen.getByText("The preview image could not be loaded.")).toBeTruthy();
    expect(screen.getByText("Image unavailable")).toBeTruthy();
    expect(
      screen.getByText("Use Refresh to request another preview image."),
    ).toBeTruthy();

    client.setQueryData(["screen-preview", "screen-1"], {
      ...preview,
      updatedAt: "capture-2",
    });

    const replacement = await screen.findByAltText(
      "Current Tilecast output for Lobby",
    );
    await waitFor(() =>
      expect(replacement.getAttribute("src")).toContain("capture-2"),
    );
    expect(screen.queryByText("Image unavailable")).toBeNull();
  });
});
