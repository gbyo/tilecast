// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { ScreenGroup, SpanStatus } from "../../api/types";
import { DisplayGroupDisplay } from "./DisplayGroupDisplay";

vi.mock("../../components/DisplayControlGroupActions", () => ({
  DisplayControlGroupActions: () => <p>Display controls</p>,
}));

const screens = [
  { id: "s1", name: "Cafeteria East", location: "" },
  { id: "s2", name: "Cafeteria West", location: "" },
];
const mirrorGroup: ScreenGroup = {
  id: "group-1",
  name: "Cafeteria",
  description: "",
  displayMode: "mirror",
  playbackEpoch: "e",
  membershipCount: 2,
  screens,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const spanGroup: ScreenGroup = { ...mirrorGroup, displayMode: "span" };
const panel = (screenId: string, x: number) => ({
  screenId,
  order: 0,
  x,
  y: 0,
  width: 1920,
  height: 1080,
  rotation: 0 as const,
  bezelLeft: 0,
  bezelTop: 0,
  bezelRight: 0,
  bezelBottom: 0,
});
const spanStatus: SpanStatus = {
  groupId: "group-1",
  displayMode: "span",
  geometry: {
    canvas: { width: 3840, height: 1080 },
    panels: [panel("s1", 0), panel("s2", 1920)],
  },
  preparations: [
    { id: "p1", screenId: "s1", status: "ready", progress: 1 },
    { id: "p2", screenId: "s2", status: "processing", progress: 0.62 },
  ],
} as never;

function renderDisplay(group: ScreenGroup) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DisplayGroupDisplay group={group} manageable csrfToken="csrf" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(api, "spanStatus").mockResolvedValue(spanStatus);
  vi.spyOn(api, "updateSpanGeometry").mockResolvedValue(spanGroup);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Display mode", () => {
  it("reveals the wall draft without changing the server until saved", async () => {
    const user = userEvent.setup();
    renderDisplay(mirrorGroup);

    expect(screen.getByRole("radio", { name: /Mirror/ })).toBeChecked();
    expect(screen.queryByLabelText("Width")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Span/ }));
    expect(await screen.findByLabelText("Canvas width")).toHaveValue(3840);
    expect(
      screen.getByText("This wall has not been saved yet."),
    ).toBeInTheDocument();
    expect(api.updateSpanGeometry).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save wall" }));
    await waitFor(() =>
      expect(api.updateSpanGeometry).toHaveBeenCalledWith(
        "group-1",
        expect.objectContaining({
          displayMode: "span",
          canvas: { width: 3840, height: 1080 },
        }),
        "csrf",
      ),
    );
  });

  it("discarding an unsaved wall goes back to Mirror", async () => {
    const user = userEvent.setup();
    renderDisplay(mirrorGroup);
    await user.click(screen.getByRole("radio", { name: /Span/ }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.getByRole("radio", { name: /Mirror/ })).toBeChecked();
    expect(screen.queryByLabelText("Canvas width")).not.toBeInTheDocument();
    expect(api.updateSpanGeometry).not.toHaveBeenCalled();
  });

  it("applies a preset as a draft command", async () => {
    const user = userEvent.setup();
    renderDisplay(mirrorGroup);
    await user.click(screen.getByRole("radio", { name: /Span/ }));
    await user.click(await screen.findByRole("button", { name: "1 × 2" }));
    expect(screen.getByLabelText("Canvas width")).toHaveValue(1920);
    expect(screen.getByLabelText("Canvas height")).toHaveValue(2160);
    expect(api.updateSpanGeometry).not.toHaveBeenCalled();
  });

  it("shows preparation progress for a saved wall", async () => {
    renderDisplay(spanGroup);
    expect(await screen.findByLabelText("Canvas width")).toHaveValue(3840);
    const west = await screen.findByRole("progressbar", {
      name: "Preparation progress for Cafeteria West",
    });
    expect(west).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("tucks panel geometry into an accordion", async () => {
    const user = userEvent.setup();
    renderDisplay(spanGroup);
    const trigger = await screen.findByRole("button", {
      name: /Cafeteria East.*1920×1080 · 0°/,
    });
    await user.click(trigger);
    const region = await screen.findByLabelText("X");
    expect(region).toHaveValue(0);
    expect(screen.getByText("Bezel compensation")).toBeInTheDocument();
  });

  it("returns to Mirror only after an explicit save", async () => {
    const user = userEvent.setup();
    renderDisplay(spanGroup);
    await screen.findByLabelText("Canvas width");
    await user.click(screen.getByRole("radio", { name: /Mirror/ }));
    expect(api.updateSpanGeometry).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save display mode" }));
    await waitFor(() =>
      expect(api.updateSpanGeometry).toHaveBeenCalledWith(
        "group-1",
        { displayMode: "mirror" },
        "csrf",
      ),
    );
  });

  it("keeps Span unavailable until the group has screens", () => {
    renderDisplay({ ...mirrorGroup, membershipCount: 0, screens: [] });
    expect(screen.getByRole("radio", { name: /Span/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.getByText("Add screens before using Span."),
    ).toBeInTheDocument();
    expect(within(document.body).queryByText("Display controls")).toBeNull();
  });
});
