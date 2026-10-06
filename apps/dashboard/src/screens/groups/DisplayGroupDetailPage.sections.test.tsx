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
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Screen, ScreenGroup } from "../../api/types";
import { DisplayGroupDetailPage } from "./DisplayGroupDetailPage";
import { normalizeGroupDetailTab } from "./displayGroupModel";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf-token",
      user: { role: "owner" },
    },
  }),
}));

vi.mock("../../api/client", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    screenGroups: vi.fn(),
    createScreenGroup: vi.fn(),
    screenGroup: vi.fn(),
    screens: vi.fn(),
    screenReliability: vi.fn(),
    playlists: vi.fn(),
    layouts: vi.fn(),
    addScreenToGroup: vi.fn(),
    removeScreenFromGroup: vi.fn(),
    updateScreenGroup: vi.fn(),
    deleteScreenGroup: vi.fn(),
    assignSyncGroupPlaylist: vi.fn(),
    assignSyncGroupLayout: vi.fn(),
    unassignSyncGroupPlaylist: vi.fn(),
  },
}));

vi.mock("../../components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm: mocks.confirm, dialog: null }),
}));

vi.mock("../../components/ui/toast", () => ({
  toast: { add: mocks.toastAdd },
}));

vi.mock("../../settings/PlayerPolicyEditor", () => ({
  PlayerPolicyEditor: ({
    onDirtyChange,
  }: {
    onDirtyChange?: (dirty: boolean) => void;
  }) => (
    <button type="button" onClick={() => onDirtyChange?.(true)}>
      Make policy dirty
    </button>
  ),
}));

vi.mock("../../components/AirPlayPresentDialog", () => ({
  AirPlayPresentDialog: () => null,
}));

vi.mock("../../components/QuickPresentDialog", () => ({
  QuickPresentDialog: () => null,
}));

vi.mock("../../components/SpanWallEditor", () => ({
  SpanWallEditor: () => <p>Wall editor</p>,
}));

vi.mock("../../components/DisplayControlGroupActions", () => ({
  DisplayControlGroupActions: () => null,
}));

function screenFixture(over: Partial<Screen> & { id: string; name: string }) {
  return {
    location: "",
    status: "online",
    enabled: true,
    ...over,
  } as Screen;
}

const member = { id: "screen-1", name: "Hall screen", location: "Library" };
const hall = screenFixture({ ...member });
const free = screenFixture({
  id: "screen-2",
  name: "Free screen",
  location: "Lobby",
});
const free2 = screenFixture({
  id: "screen-3",
  name: "Second free",
  location: "Gym",
});
const taken = screenFixture({
  id: "screen-4",
  name: "Lobby TV",
  location: "Lobby",
  syncGroupId: "group-2",
  syncGroupName: "Lobby Displays",
});
const group: ScreenGroup = {
  id: "group-1",
  name: "North Wing",
  description: "",
  displayMode: "mirror",
  playbackEpoch: "epoch-1",
  membershipCount: 1,
  screens: [member],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const emptyGroup: ScreenGroup = {
  ...group,
  membershipCount: 0,
  screens: [],
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };

  mocks.confirm.mockResolvedValue(true);
  vi.mocked(api.screenGroups).mockResolvedValue({ items: [group] } as never);
  vi.mocked(api.screenGroup).mockResolvedValue(group);
  vi.mocked(api.screens).mockResolvedValue({
    items: [hall, free, free2, taken],
  } as never);
  vi.mocked(api.screenReliability).mockResolvedValue({} as never);
  vi.mocked(api.playlists).mockResolvedValue({
    items: [{ id: "playlist-1", name: "Morning" }],
  } as never);
  vi.mocked(api.layouts).mockResolvedValue({
    items: [{ id: "layout-1", name: "Split", publishedRevision: 2 }],
  } as never);
  vi.mocked(api.createScreenGroup).mockResolvedValue(group);
  vi.mocked(api.addScreenToGroup).mockResolvedValue(group);
  vi.mocked(api.removeScreenFromGroup).mockResolvedValue(undefined);
  vi.mocked(api.updateScreenGroup).mockResolvedValue(group);
  vi.mocked(api.deleteScreenGroup).mockResolvedValue(undefined);
  vi.mocked(api.assignSyncGroupPlaylist).mockResolvedValue(group);
  vi.mocked(api.assignSyncGroupLayout).mockResolvedValue(group);
  vi.mocked(api.unassignSyncGroupPlaylist).mockResolvedValue(group);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderGroupDetail(entries: string[] = ["/groups/group-1"]) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={entries}>
        <Routes>
          <Route path="/groups/:id" element={<DisplayGroupDetailPage />} />
          <Route path="/groups" element={<h1>Display Groups index</h1>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function expectErrorToast(title: string) {
  await waitFor(() => {
    expect(mocks.toastAdd).toHaveBeenCalledWith({ title, type: "error" });
  });
}

async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(await screen.findByRole("button", { name }));
}

describe("Display Group header", () => {
  it("keeps frequent actions visible and puts edit and delete in the overflow", async () => {
    const user = userEvent.setup();
    renderGroupDetail();

    expect(
      await screen.findByRole("heading", { name: "North Wing" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show now" })).toBeVisible();
    expect(screen.getByRole("button", { name: "AirPlay" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Delete Display Group" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit details" }),
    ).not.toBeInTheDocument();

    await openMenu(user, "More actions");
    expect(
      await screen.findByRole("menuitem", { name: "Edit details" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete Display Group" }),
    ).toBeInTheDocument();
  });

  it("states membership, mode, and fallback as quiet metadata", async () => {
    vi.mocked(api.screenGroup).mockResolvedValue({
      ...group,
      playlistId: "playlist-1",
      playlistName: "Morning",
    });
    renderGroupDetail();
    expect(
      await screen.findByText("1 screen · Mirror · Playlist: Morning"),
    ).toBeInTheDocument();
  });
});

describe("Display Group mutation failures", () => {
  it("keeps the edit dialog and entered values after an update failure", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateScreenGroup).mockRejectedValueOnce(
      new Error("network failure"),
    );
    renderGroupDetail();

    await openMenu(user, "More actions");
    await user.click(
      await screen.findByRole("menuitem", { name: "Edit details" }),
    );
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Renamed Wing");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await expectErrorToast("Could not update the Display Group.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(name).toHaveValue("Renamed Wing");
  });

  it("surfaces removal, assignment, and deletion failures", async () => {
    const user = userEvent.setup();
    vi.mocked(api.removeScreenFromGroup).mockRejectedValueOnce(
      new Error("network failure"),
    );
    vi.mocked(api.assignSyncGroupPlaylist).mockRejectedValueOnce(
      new Error("network failure"),
    );
    vi.mocked(api.deleteScreenGroup).mockRejectedValueOnce(
      new Error("network failure"),
    );
    renderGroupDetail(["/groups/group-1?tab=members"]);

    await openMenu(user, "Actions for Hall screen");
    await user.click(
      await screen.findByRole("menuitem", {
        name: "Remove from Display Group",
      }),
    );
    await expectErrorToast(
      "Could not remove the screen from the Display Group.",
    );

    mocks.toastAdd.mockClear();
    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    await user.click(
      await screen.findByRole("combobox", { name: "Presentation" }),
    );
    await user.click(await screen.findByRole("option", { name: "Morning" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await expectErrorToast("Could not update the Display Group assignment.");

    mocks.toastAdd.mockClear();
    await openMenu(user, "More actions");
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete Display Group" }),
    );
    await waitFor(() => expect(api.deleteScreenGroup).toHaveBeenCalled());
    await expectErrorToast("Could not delete the Display Group.");
    expect(
      screen.getByRole("heading", { name: "North Wing" }),
    ).toBeInTheDocument();
  });

  it("returns to the index after a confirmed delete", async () => {
    const user = userEvent.setup();
    renderGroupDetail();
    await openMenu(user, "More actions");
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete Display Group" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Display Groups index" }),
    ).toBeInTheDocument();
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Screens will not be deleted.",
        destructive: true,
      }),
    );
  });
});

describe("DisplayGroupDetailPage sections", () => {
  it("normalizes tab parameters to known sections", () => {
    expect(normalizeGroupDetailTab(null)).toBe("overview");
    expect(normalizeGroupDetailTab("members")).toBe("members");
    expect(normalizeGroupDetailTab("content")).toBe("content");
    expect(normalizeGroupDetailTab("display")).toBe("display");
    expect(normalizeGroupDetailTab("policy")).toBe("policy");
    expect(normalizeGroupDetailTab("bogus")).toBe("overview");
  });

  it("names the tabs for what they contain and shows one at a time", async () => {
    const user = userEvent.setup();
    renderGroupDetail();

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Overview",
      "Screens",
      "Playback",
      "Display",
      "Player policy",
    ]);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Overview",
    );
    expect(
      screen.queryByRole("combobox", { name: "Presentation" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Screens" }));
    expect(
      await screen.findByRole("link", { name: /^Hall screen/ }),
    ).toHaveAttribute("href", "/screens/screen-1");

    await user.click(screen.getByRole("tab", { name: "Playback" }));
    expect(
      await screen.findByRole("combobox", { name: "Presentation" }),
    ).toBeInTheDocument();
  });

  it("honors deep-linked sections", async () => {
    renderGroupDetail(["/groups/group-1?tab=members"]);
    expect(
      await screen.findByRole("link", { name: /^Hall screen/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Screens",
    );
  });

  it("guards navigation away from a dirty policy", async () => {
    const user = userEvent.setup();
    renderGroupDetail(["/groups/group-1?tab=policy"]);

    await user.click(
      await screen.findByRole("button", { name: "Make policy dirty" }),
    );
    expect(
      await screen.findByRole("tab", { name: /Player policy.*Unsaved/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Overview" }));
    expect(
      await screen.findByRole("heading", {
        name: "Discard unsaved group settings?",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Player policy",
    );

    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await user.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Overview",
    );
    expect(
      screen.queryByRole("button", { name: "Make policy dirty" }),
    ).not.toBeInTheDocument();
  });
});

describe("Overview", () => {
  it("summarizes screens, fallback, and mode, each opening its tab", async () => {
    const user = userEvent.setup();
    vi.mocked(api.screens).mockResolvedValue({
      items: [{ ...hall, status: "offline" }, free],
    } as never);
    vi.mocked(api.screenGroup).mockResolvedValue({
      ...group,
      playlistId: "playlist-1",
      playlistName: "Morning",
    });
    renderGroupDetail();

    expect(
      await screen.findByText("1 screen · 1 needs attention"),
    ).toBeInTheDocument();
    expect(screen.getByText("Playlist · Morning")).toBeInTheDocument();
    expect(
      screen.getByText("Mirror · synchronized playback"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Fallback playback/ }));
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Playback",
    );
  });

  it("offers setup instead of empty rows for a group with no screens", async () => {
    const user = userEvent.setup();
    vi.mocked(api.screenGroup).mockResolvedValue(emptyGroup);
    renderGroupDetail();

    expect(
      await screen.findByText("Add screens to this Display Group"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Fallback playback")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add screens" }));
    expect(
      await screen.findByRole("dialog", { name: "Add screens" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { selected: true, hidden: true }),
    ).toHaveTextContent("Screens");
  });
});

describe("Screens tab", () => {
  it("reports health in Fleet vocabulary", async () => {
    vi.mocked(api.screens).mockResolvedValue({
      items: [{ ...hall, status: "offline" }],
    } as never);
    renderGroupDetail(["/groups/group-1?tab=members"]);
    const row = (
      await screen.findByRole("link", { name: /^Hall screen/ })
    ).closest("tr") as HTMLElement;
    expect(within(row).getByText("Needs attention")).toBeInTheDocument();
    expect(within(row).getByText("Offline")).toBeInTheDocument();
    expect(within(row).getByText("Library")).toBeInTheDocument();
  });

  it("filters the group's own screens", async () => {
    const user = userEvent.setup();
    renderGroupDetail(["/groups/group-1?tab=members"]);
    await user.type(
      await screen.findByRole("searchbox", { name: "Search group screens" }),
      "nothing",
    );
    expect(
      await screen.findByText("No screens in this group match your search."),
    ).toBeInTheDocument();
  });
});

describe("Add screens picker", () => {
  it("lists available screens and explains screens owned by another group", async () => {
    const user = userEvent.setup();
    renderGroupDetail(["/groups/group-1?tab=members"]);
    await user.click(
      await screen.findByRole("button", { name: "Add screens" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Add screens" });
    expect(
      await within(dialog).findByRole("checkbox", { name: /^Free screen/ }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(
      within(dialog).queryByRole("checkbox", { name: /^Hall screen/ }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("Already in another Display Group"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("checkbox", { name: /^Lobby TV/ }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByText("In “Lobby Displays”")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: "View group" }),
    ).toHaveAttribute("href", "/groups/group-2");
  });

  it("adds every selected screen and closes when all succeed", async () => {
    const user = userEvent.setup();
    renderGroupDetail(["/groups/group-1?tab=members"]);
    await user.click(
      await screen.findByRole("button", { name: "Add screens" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Add screens" });

    expect(
      await within(dialog).findByRole("button", { name: "Add screens" }),
    ).toBeDisabled();
    await user.click(
      await within(dialog).findByRole("checkbox", { name: /^Free screen/ }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: /^Second free/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add 2 screens" }),
    );

    await waitFor(() => expect(api.addScreenToGroup).toHaveBeenCalledTimes(2));
    expect(api.addScreenToGroup).toHaveBeenCalledWith(
      "group-1",
      "screen-2",
      "csrf-token",
    );
    expect(api.addScreenToGroup).toHaveBeenCalledWith(
      "group-1",
      "screen-3",
      "csrf-token",
    );
    await waitFor(() =>
      expect(mocks.toastAdd).toHaveBeenCalledWith({
        title: "2 screens added.",
        type: "success",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add screens" })).toBeNull(),
    );
  });

  it("keeps failed screens selected and says which ones failed", async () => {
    const user = userEvent.setup();
    vi.mocked(api.addScreenToGroup).mockImplementation(
      (_group: string, screenId: string) =>
        screenId === "screen-3"
          ? Promise.reject(new Error("conflict"))
          : Promise.resolve(group),
    );
    renderGroupDetail(["/groups/group-1?tab=members"]);
    await user.click(
      await screen.findByRole("button", { name: "Add screens" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Add screens" });
    await user.click(
      await within(dialog).findByRole("checkbox", { name: /^Free screen/ }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: /^Second free/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add 2 screens" }),
    );

    expect(
      await within(dialog).findByText(
        "Some screens could not be added: Second free. They are still selected; try again.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("checkbox", { name: /^Second free/ }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: /^Free screen/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("dialog", { name: "Add screens" }),
    ).toBeInTheDocument();
  });
});

describe("Playback tab", () => {
  it("enables Save only when the selection differs from the assignment", async () => {
    const user = userEvent.setup();
    renderGroupDetail(["/groups/group-1?tab=content"]);
    const save = await screen.findByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Presentation" }));
    expect(await screen.findByText("Playlists")).toBeInTheDocument();
    expect(screen.getByText("Layouts")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "No fallback presentation" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Split" }));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() =>
      expect(api.assignSyncGroupLayout).toHaveBeenCalledWith(
        "group-1",
        "layout-1",
        "csrf-token",
      ),
    );
  });

  it("hides the gateway section when the group has no screens", async () => {
    vi.mocked(api.screenGroup).mockResolvedValue(emptyGroup);
    renderGroupDetail(["/groups/group-1?tab=content"]);
    await screen.findByRole("combobox", { name: "Presentation" });
    expect(screen.queryByText("AirPlay gateway")).not.toBeInTheDocument();
  });
});
