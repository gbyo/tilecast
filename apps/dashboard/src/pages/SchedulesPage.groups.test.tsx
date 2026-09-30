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
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { ScreenGroup } from "../api/types";
import {
  GroupDetailPage,
  GroupsPage,
  normalizeGroupDetailTab,
} from "./SchedulesPage";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf-token",
      user: { role: "owner" },
    },
  }),
}));

vi.mock("../api/client", () => ({
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

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm: mocks.confirm, dialog: null }),
}));

vi.mock("../components/ui/toast", () => ({
  toast: { add: mocks.toastAdd },
}));

vi.mock("../settings/PlayerPolicyEditor", () => ({
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

vi.mock("../components/AirPlayPresentDialog", () => ({
  AirPlayPresentDialog: () => null,
}));

vi.mock("../components/QuickPresentDialog", () => ({
  QuickPresentDialog: () => null,
}));

vi.mock("../components/SpanWallEditor", () => ({
  SpanWallEditor: () => null,
}));

vi.mock("../components/DisplayControlGroupActions", () => ({
  DisplayControlGroupActions: () => null,
}));

const member = { id: "screen-1", name: "Hall screen", location: "Library" };
const available = { id: "screen-2", name: "Free screen", location: "Lobby" };
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
    items: [member, available],
  } as never);
  vi.mocked(api.screenReliability).mockResolvedValue({} as never);
  vi.mocked(api.playlists).mockResolvedValue({
    items: [{ id: "playlist-1", name: "Morning" }],
  } as never);
  vi.mocked(api.layouts).mockResolvedValue({ items: [] } as never);
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

function renderGroups() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
          <Route path="/groups/:id" element={<GroupDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function expectErrorToast(title: string) {
  await waitFor(() => {
    expect(mocks.toastAdd).toHaveBeenCalledWith({ title, type: "error" });
  });
}

describe("Display Group mutation failures", () => {
  it("keeps the create dialog and entered values after failure, then closes on success", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createScreenGroup)
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce(group);
    renderGroups();

    await user.click(
      await screen.findByRole("button", { name: "Create Display Group" }),
    );
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Group name" });
    await user.type(name, "West Wing");
    await user.click(
      within(dialog).getByRole("button", { name: "Create group" }),
    );

    await expectErrorToast("Could not create the Display Group.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(name).toHaveValue("West Wing");

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Create group",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(api.createScreenGroup).toHaveBeenCalledTimes(2);
  });

  it("keeps the edit dialog and entered values after an update failure", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateScreenGroup).mockRejectedValueOnce(
      new Error("network failure"),
    );
    renderGroupDetail();

    await user.click(
      await screen.findByRole("button", { name: "Edit Display Group" }),
    );
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Group name" });
    await user.clear(name);
    await user.type(name, "Renamed Wing");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await expectErrorToast("Could not update the Display Group.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(name).toHaveValue("Renamed Wing");
  });

  it("surfaces membership, assignment, and deletion failures", async () => {
    const user = userEvent.setup();
    vi.mocked(api.addScreenToGroup).mockRejectedValueOnce(
      new Error("network failure"),
    );
    vi.mocked(api.removeScreenFromGroup).mockRejectedValueOnce(
      new Error("network failure"),
    );
    vi.mocked(api.assignSyncGroupPlaylist).mockRejectedValueOnce(
      new Error("network failure"),
    );
    vi.mocked(api.deleteScreenGroup).mockRejectedValueOnce(
      new Error("network failure"),
    );
    renderGroupDetail();

    await user.click(await screen.findByRole("tab", { name: "Members" }));
    await user.click(
      await screen.findByRole("combobox", { name: "Add screen" }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Free screen/ }),
    );
    await expectErrorToast("Could not add the screen to the Display Group.");

    mocks.toastAdd.mockClear();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await expectErrorToast(
      "Could not remove the screen from the Display Group.",
    );

    mocks.toastAdd.mockClear();
    await user.click(await screen.findByRole("tab", { name: "Content" }));
    await user.click(
      await screen.findByRole("combobox", {
        name: "Display Group fallback content",
      }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Playlist · Morning" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Apply to Display Group" }),
    );
    await expectErrorToast("Could not update the Display Group assignment.");

    mocks.toastAdd.mockClear();
    await user.click(
      screen.getByRole("button", { name: "Delete Display Group" }),
    );
    await waitFor(() => expect(api.deleteScreenGroup).toHaveBeenCalled());
    await expectErrorToast("Could not delete the Display Group.");
    expect(
      screen.getByRole("heading", { name: "North Wing" }),
    ).toBeInTheDocument();
  });
});

describe("GroupDetailPage sections", () => {
  it("normalizes tab parameters to known sections", () => {
    expect(normalizeGroupDetailTab(null)).toBe("overview");
    expect(normalizeGroupDetailTab("members")).toBe("members");
    expect(normalizeGroupDetailTab("content")).toBe("content");
    expect(normalizeGroupDetailTab("display")).toBe("display");
    expect(normalizeGroupDetailTab("policy")).toBe("policy");
    expect(normalizeGroupDetailTab("bogus")).toBe("overview");
  });

  it("shows one section at a time starting from overview", async () => {
    const user = userEvent.setup();
    renderGroupDetail();

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Overview",
      "Members",
      "Content",
      "Display",
      "Policy",
    ]);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Overview",
    );
    expect(
      screen.queryByRole("combobox", { name: "Add screen" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", {
        name: "Display Group fallback content",
      }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Members" }));
    expect(
      await screen.findByRole("combobox", { name: "Add screen" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", {
        name: "Display Group fallback content",
      }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Content" }));
    expect(
      await screen.findByRole("combobox", {
        name: "Display Group fallback content",
      }),
    ).toBeInTheDocument();
  });

  it("honors deep-linked sections", async () => {
    renderGroupDetail(["/groups/group-1?tab=members"]);
    expect(
      await screen.findByRole("combobox", { name: "Add screen" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Members",
    );
  });

  it("guards navigation away from a dirty policy", async () => {
    const user = userEvent.setup();
    renderGroupDetail(["/groups/group-1?tab=policy"]);

    await user.click(
      await screen.findByRole("button", { name: "Make policy dirty" }),
    );
    expect(
      await screen.findByRole("tab", { name: /Policy.*Unsaved/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Overview" }));
    expect(
      await screen.findByRole("heading", {
        name: "Discard unsaved group settings?",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Policy",
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
