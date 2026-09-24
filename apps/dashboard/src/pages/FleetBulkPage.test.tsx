// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { FleetBulkPage } from "./FleetBulkPage";
import { api } from "../api/client";
import type { BulkPreview } from "../api/types";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));

const preview: BulkPreview = {
  action: "assign_playlist",
  screens: [
    {
      screenId: "s1",
      name: "Cafeteria",
      current: "Playlist: Old menu",
      next: "Playlist: New menu",
      changes: true,
      selected: true,
    },
    {
      screenId: "s2",
      name: "Gym",
      current: "Nothing assigned",
      next: "Playlist: New menu",
      changes: true,
      selected: false,
      fromGroup: "North Wing",
    },
    {
      screenId: "s3",
      name: "Old lobby TV",
      current: "Nothing assigned",
      next: "Playlist: New menu",
      changes: false,
      blocked: "Archived",
      selected: true,
    },
  ],
  changeCount: 2,
  unchangedCount: 0,
  blockedCount: 1,
  groupAddedCount: 1,
  warnings: [
    "1 more screens are included because they share a Display Group (North Wing). A Display Group plays one assignment on every member.",
  ],
  reversible: true,
  undoWindowMinutes: 15,
};

// Studio's Select is a Base UI combobox, not a native <select>: open it, then
// click the option.
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string | RegExp,
) {
  await user.click(await screen.findByLabelText(label));
  await user.click(await screen.findByRole("option", { name: option }));
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FleetBulkPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Fleet bulk changes", () => {
  beforeEach(() => {
    // The page reads a handful of fields from each list; the fixtures carry
    // those and are widened rather than restating whole API shapes.
    const widen = <T,>(value: unknown) => value as T;
    vi.spyOn(api, "screens").mockResolvedValue(
      widen<Awaited<ReturnType<typeof api.screens>>>({
        items: [
          { id: "s1", name: "Cafeteria" },
          { id: "s2", name: "Gym", syncGroupName: "North Wing" },
        ],
        total: 2,
      }),
    );
    vi.spyOn(api, "playlists").mockResolvedValue(
      widen<Awaited<ReturnType<typeof api.playlists>>>({
        items: [{ id: "p1", name: "New menu" }],
        total: 1,
      }),
    );
    vi.spyOn(api, "layouts").mockResolvedValue(
      widen<Awaited<ReturnType<typeof api.layouts>>>({ items: [], total: 0 }),
    );
    vi.spyOn(api, "bulkOperations").mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("will not preview until screens and a playlist are chosen", async () => {
    renderPage();
    const button = await screen.findByRole("button", {
      name: /Preview the change/,
    });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("names the screens pulled in by a Display Group before anything is applied", async () => {
    const build = vi
      .spyOn(api, "previewBulkOperation")
      .mockResolvedValue(preview);
    renderPage();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("checkbox", { name: /Cafeteria/ }),
    );
    await choose(user, "Playlist", "New menu");
    await user.click(
      screen.getByRole("button", { name: /Preview the change/ }),
    );

    await waitFor(() => expect(build).toHaveBeenCalled());
    expect(await screen.findByText(/Gym \(via North Wing\)/)).toBeTruthy();
    expect(screen.getByText(/share a Display Group/)).toBeTruthy();
  });

  it("reports a blocked screen as skipped rather than dropping it", async () => {
    vi.spyOn(api, "previewBulkOperation").mockResolvedValue(preview);
    renderPage();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("checkbox", { name: /Cafeteria/ }),
    );
    await choose(user, "Playlist", "New menu");
    await user.click(
      screen.getByRole("button", { name: /Preview the change/ }),
    );

    expect(await screen.findByText(/Skipped: Archived/)).toBeTruthy();
  });

  it("confirms with the number of screens that actually move", async () => {
    vi.spyOn(api, "previewBulkOperation").mockResolvedValue(preview);
    renderPage();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("checkbox", { name: /Cafeteria/ }),
    );
    await choose(user, "Playlist", "New menu");
    await user.click(
      screen.getByRole("button", { name: /Preview the change/ }),
    );

    // Three rows are listed, two of them change. The button must say two.
    expect(
      await screen.findByRole("button", { name: "Change 2 screens" }),
    ).toBeTruthy();
  });

  it("sends the confirmed change count so a moved fleet is caught", async () => {
    vi.spyOn(api, "previewBulkOperation").mockResolvedValue(preview);
    const apply = vi.spyOn(api, "applyBulkOperation").mockResolvedValue({
      id: "op1",
      action: "assign_playlist",
      screenCount: 3,
      appliedCount: 2,
      skippedCount: 1,
      failedCount: 0,
      results: [],
      reversible: true,
      createdAt: "2026-03-04T12:00:00Z",
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("checkbox", { name: /Cafeteria/ }),
    );
    await choose(user, "Playlist", "New menu");
    await user.click(
      screen.getByRole("button", { name: /Preview the change/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Change 2 screens" }),
    );

    await waitFor(() => expect(apply).toHaveBeenCalled());
    const [applied] = apply.mock.calls[0] ?? [];
    expect(applied?.expectedChangeCount).toBe(2);
  });

  it("offers undo after a reversible change", async () => {
    vi.spyOn(api, "previewBulkOperation").mockResolvedValue(preview);
    vi.spyOn(api, "applyBulkOperation").mockResolvedValue({
      id: "op1",
      action: "assign_playlist",
      screenCount: 3,
      appliedCount: 2,
      skippedCount: 1,
      failedCount: 0,
      results: [],
      reversible: true,
      createdAt: "2026-03-04T12:00:00Z",
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("checkbox", { name: /Cafeteria/ }),
    );
    await choose(user, "Playlist", "New menu");
    await user.click(
      screen.getByRole("button", { name: /Preview the change/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Change 2 screens" }),
    );

    expect(
      await screen.findByRole("button", { name: /Undo this change/ }),
    ).toBeTruthy();
  });

  it("warns that a command cannot be undone", async () => {
    renderPage();
    const user = userEvent.setup();
    await choose(user, "Action", "Send a command");
    expect(
      screen.getByText(/cannot be undone once a Player collects it/),
    ).toBeTruthy();
  });
});
