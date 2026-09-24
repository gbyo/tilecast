// @vitest-environment jsdom

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { SnapshotHistoryPanel } from "./SnapshotHistoryPanel";
import { api } from "../api/client";

const proofNote = "Captured from Tilecast Player.";

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SnapshotHistoryPanel screenId="s1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Snapshot history", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("distinguishes history being off from nothing having happened", async () => {
    vi.spyOn(api, "screenSnapshots").mockResolvedValue({
      items: [],
      enabled: false,
      retentionDays: 7,
      maxPerScreen: 48,
      proofNote,
    });
    renderPanel();
    expect(await screen.findByText(/Snapshot history is off/)).toBeTruthy();
  });

  it("says an empty history is empty, not off, when it is enabled", async () => {
    vi.spyOn(api, "screenSnapshots").mockResolvedValue({
      items: [],
      enabled: true,
      retentionDays: 7,
      maxPerScreen: 48,
      proofNote,
    });
    renderPanel();
    expect(await screen.findByText(/No snapshots yet/)).toBeTruthy();
  });

  it("shows the configured retention", async () => {
    vi.spyOn(api, "screenSnapshots").mockResolvedValue({
      items: [
        {
          id: "n1",
          screenId: "s1",
          capturedAt: "2026-03-04T10:14:00Z",
          width: 1920,
          height: 1080,
          fileSize: 12345,
          trigger: "scheduled",
        },
      ],
      enabled: true,
      retentionDays: 7,
      maxPerScreen: 48,
      proofNote,
    });
    renderPanel();
    expect(
      await screen.findByText(/Retains up to 48 per screen for 7 days/),
    ).toBeTruthy();
  });

  it("marks a manual capture so it is not read as a scheduled one", async () => {
    vi.spyOn(api, "screenSnapshots").mockResolvedValue({
      items: [
        {
          id: "n1",
          screenId: "s1",
          capturedAt: "2026-03-04T10:14:00Z",
          width: 1920,
          height: 1080,
          fileSize: 12345,
          trigger: "manual",
        },
      ],
      enabled: true,
      retentionDays: 7,
      maxPerScreen: 48,
      proofNote,
    });
    renderPanel();
    expect(await screen.findByText(/manual/)).toBeTruthy();
  });

  it("opens a snapshot from a generated button with pointer or keyboard", async () => {
    vi.spyOn(api, "screenSnapshots").mockResolvedValue({
      items: [
        {
          id: "n1",
          screenId: "s1",
          capturedAt: "2026-03-04T10:14:00Z",
          width: 1920,
          height: 1080,
          fileSize: 12345,
          trigger: "scheduled",
        },
      ],
      enabled: true,
      retentionDays: 7,
      maxPerScreen: 48,
      proofNote,
    });
    renderPanel();
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", {
      name: /View the snapshot from/,
    });
    expect(trigger.getAttribute("data-slot")).toBe("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Open full size")).toBeTruthy();

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Open full size")).toBeNull();

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard(" ");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
