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
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Screen, ScreenGroup } from "../../api/types";
import { AddScreensPicker } from "./AddScreensPicker";

const mocks = vi.hoisted(() => ({ toastAdd: vi.fn() }));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf-token", user: { role: "owner" } },
  }),
}));

vi.mock("../../api/client", () => ({
  ApiError: class ApiError extends Error {},
  api: { screens: vi.fn(), addScreenToGroup: vi.fn() },
}));

vi.mock("../../components/ui/toast", () => ({
  toast: { add: mocks.toastAdd },
}));

const fixture = (over: Partial<Screen> & { id: string; name: string }) =>
  ({ location: "", status: "online", enabled: true, ...over }) as Screen;

const member = fixture({ id: "screen-1", name: "Hall screen" });
const free = fixture({
  id: "screen-2",
  name: "Free screen",
  location: "Lobby",
});
const second = fixture({
  id: "screen-3",
  name: "Second free",
  location: "Gym",
});
const taken = fixture({
  id: "screen-4",
  name: "Lobby TV",
  syncGroupId: "group-2",
  syncGroupName: "Lobby Displays",
});
const group: ScreenGroup = {
  id: "group-1",
  name: "North Wing",
  description: "",
  displayMode: "mirror",
  playbackEpoch: "e",
  membershipCount: 1,
  screens: [{ id: "screen-1", name: "Hall screen", location: "" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function stubCompact(compact: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: compact && query.includes("max-width"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  }));
}

function renderPicker(onOpenChange = vi.fn()) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <AddScreensPicker group={group} open onOpenChange={onOpenChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onOpenChange;
}

beforeEach(() => {
  vi.mocked(api.screens).mockResolvedValue({
    items: [member, free, second, taken],
    total: 4,
  });
  vi.mocked(api.addScreenToGroup).mockResolvedValue(group);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

// The Sheet and the Drawer share one body, so every behavior holds in both.
describe.each([
  ["desktop Sheet", false],
  ["compact Drawer", true],
])("Add screens picker in a %s", (_name, compact) => {
  beforeEach(() => stubCompact(compact));

  const open = async () => {
    const dialog = await screen.findByRole("dialog", { name: "Add screens" });
    await within(dialog).findByRole("checkbox", { name: "Select Free screen" });
    return dialog;
  };

  it("names each checkbox for its screen and lists real list items", async () => {
    renderPicker();
    const dialog = await open();
    const list = within(dialog).getByRole("list", {
      name: "Available screens",
    });
    expect(list.tagName).toBe("UL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(dialog).queryByRole("checkbox", { name: /Hall screen/ }),
    ).not.toBeInTheDocument();
    // Name, location, and status stay readable beside the control.
    expect(within(dialog).getByText("Lobby · Online")).toBeInTheDocument();
  });

  it("toggles once from a click on the row", async () => {
    const user = userEvent.setup();
    renderPicker();
    const dialog = await open();
    const checkbox = within(dialog).getByRole("checkbox", {
      name: "Select Free screen",
    });

    await user.click(within(dialog).getByText("Free screen"));
    expect(checkbox).toBeChecked();
    expect(
      within(dialog).getByRole("button", { name: "Add 1 screen" }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByText("Lobby · Online"));
    expect(checkbox).not.toBeChecked();
  });

  it("toggles once from a click on the checkbox itself", async () => {
    const user = userEvent.setup();
    renderPicker();
    const dialog = await open();
    const checkbox = within(dialog).getByRole("checkbox", {
      name: "Select Free screen",
    });
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("toggles from the keyboard", async () => {
    const user = userEvent.setup();
    renderPicker();
    const dialog = await open();
    const checkbox = within(dialog).getByRole("checkbox", {
      name: "Select Free screen",
    });
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
  });

  it("cannot select a screen that another group owns, but links to that group", async () => {
    const user = userEvent.setup();
    renderPicker();
    const dialog = await open();
    const locked = within(dialog).getByRole("checkbox", {
      name: "Select Lobby TV",
    });
    expect(locked).toHaveAttribute("aria-disabled", "true");
    await user.click(within(dialog).getByText("Lobby TV"));
    await user.click(locked);
    expect(locked).not.toBeChecked();
    expect(
      within(dialog).getByRole("button", { name: "Add screens" }),
    ).toBeDisabled();

    const link = within(dialog).getByRole("link", { name: "View group" });
    expect(link).toHaveAttribute("href", "/groups/group-2");
    link.focus();
    expect(link).toHaveFocus();
  });

  it("adds every selected screen and closes when all succeed", async () => {
    const user = userEvent.setup();
    const onOpenChange = renderPicker();
    const dialog = await open();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Select Free screen" }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Select Second free" }),
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
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("keeps failed screens selected, drops added ones, and stays open", async () => {
    const user = userEvent.setup();
    vi.mocked(api.addScreenToGroup).mockImplementation(
      (_group: string, screenId: string) =>
        screenId === "screen-3"
          ? Promise.reject(new Error("conflict"))
          : Promise.resolve(group),
    );
    const onOpenChange = renderPicker();
    const dialog = await open();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Select Free screen" }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Select Second free" }),
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
      within(dialog).getByRole("checkbox", { name: "Select Second free" }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: "Select Free screen" }),
    ).not.toBeChecked();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      title: "1 screen added.",
      type: "success",
    });
  });

  it("disables selection while screens are being added", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    vi.mocked(api.addScreenToGroup).mockReturnValue(
      new Promise<ScreenGroup>((resolve) => {
        release = () => resolve(group);
      }),
    );
    renderPicker();
    const dialog = await open();
    const checkbox = within(dialog).getByRole("checkbox", {
      name: "Select Free screen",
    });
    await user.click(checkbox);
    await user.click(
      within(dialog).getByRole("button", { name: "Add 1 screen" }),
    );
    await waitFor(() =>
      expect(checkbox).toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(within(dialog).getByText("Second free"));
    expect(
      within(dialog).getByRole("checkbox", { name: "Select Second free" }),
    ).not.toBeChecked();
    release();
  });
});
