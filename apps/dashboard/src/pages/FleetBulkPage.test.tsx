// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { FleetBulkPage } from "./FleetBulkPage";
import { api, ApiError } from "../api/client";
import { toast } from "../components/ui/toast";
import type { BulkPreview } from "../api/types";

const authMocks = vi.hoisted(() => ({ role: "owner" }));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { role: authMocks.role } },
  }),
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
    authMocks.role = "owner";
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

  it.each(["editor", "contributor", "viewer"] as const)(
    "denies %s access without loading bulk data",
    async (role) => {
      authMocks.role = role;
      renderPage();

      expect(
        await screen.findByText(
          "Only Owners and Administrators can use bulk changes.",
        ),
      ).toBeTruthy();
      expect(api.screens).not.toHaveBeenCalled();
      expect(api.playlists).not.toHaveBeenCalled();
      expect(api.layouts).not.toHaveBeenCalled();
      expect(api.bulkOperations).not.toHaveBeenCalled();
    },
  );

  it("allows administrators to load bulk changes", async () => {
    authMocks.role = "administrator";
    renderPage();

    expect(
      await screen.findByRole("button", { name: /Preview the change/ }),
    ).toBeTruthy();
    await waitFor(() => expect(api.screens).toHaveBeenCalled());
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
    await user.click(
      await screen.findByRole("radio", { name: "Send a command" }),
    );
    expect(
      screen.getByText(/cannot be undone once a Player collects it/),
    ).toBeTruthy();
  });

  it("reads a moved fleet as a mismatch with a review action, not a crash", async () => {
    const build = vi
      .spyOn(api, "previewBulkOperation")
      .mockResolvedValue(preview);
    vi.spyOn(api, "applyBulkOperation").mockRejectedValue(
      new ApiError("Conflict.", 409, "bulk_operation_stale"),
    );
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
      await screen.findByText(/Screens changed since this preview/),
    ).toBeTruthy();
    const review = screen.getByRole("button", { name: "Review changes" });
    await user.click(review);
    await waitFor(() => expect(build).toHaveBeenCalledTimes(2));
  });

  it("announces applied and undone changes with localized toasts", async () => {
    const added = vi.spyOn(toast, "add");
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
    vi.spyOn(api, "undoBulkOperation").mockResolvedValue({
      id: "op1",
      action: "assign_playlist",
      screenCount: 3,
      appliedCount: 2,
      skippedCount: 1,
      failedCount: 0,
      results: [],
      reversible: false,
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

    await waitFor(() =>
      expect(added).toHaveBeenCalledWith({
        title: "Bulk changes applied.",
        type: "success",
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: /Undo this change/ }),
    );
    await waitFor(() =>
      expect(added).toHaveBeenCalledWith({
        title: "Bulk changes undone.",
        type: "success",
      }),
    );
  });

  it("reports a failed screen load as an error with retry, not as empty", async () => {
    vi.spyOn(api, "screens").mockRejectedValue(new Error("boom"));
    renderPage();

    expect(await screen.findByText(/Screens could not be loaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No screens are paired yet")).toBeNull();
  });
});
