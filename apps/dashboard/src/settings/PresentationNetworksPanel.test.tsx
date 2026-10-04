// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresentationNetworksPanel } from "./PresentationNetworksPanel";
import { api } from "../api/client";
import type { Screen } from "../api/types";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "tok" } }),
}));

const lobby = {
  id: "s1",
  name: "Lobby",
  location: "First floor",
  platform: "linux",
} as unknown as Screen;
const hall = {
  id: "s2",
  name: "Hall",
  location: "Second floor",
  platform: "Linux",
} as unknown as Screen;
const kiosk = {
  id: "s3",
  name: "Kiosk",
  location: "Entrance",
  platform: "android",
} as unknown as Screen;

function mockLists() {
  vi.spyOn(api, "presentationNetworks").mockResolvedValue({
    items: [],
    credentialsAvailable: true,
    credentialsUnavailableReason: "",
    supportedSecurity: [
      { value: "wpa_psk", label: "WPA2 Personal", enterprise: false },
    ],
  });
  vi.spyOn(api, "screens").mockResolvedValue({
    items: [lobby, hall, kiosk],
    total: 3,
  });
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter([
    { path: "*", element: <PresentationNetworksPanel canManage /> },
  ]);
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PresentationNetworksPanel assignment picker", () => {
  it("filters Linux candidates through the search field", async () => {
    mockLists();
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Add network" }),
    );
    expect(
      await screen.findByLabelText("Search Linux players"),
    ).toBeInTheDocument();
    // Only Linux players are candidates; platform matching is case-insensitive.
    expect(
      screen.getByRole("checkbox", { name: "Lobby · First floor" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Hall · Second floor" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Kiosk/ })).toBe(null);

    await user.type(screen.getByLabelText("Search Linux players"), "second");
    expect(screen.queryByRole("checkbox", { name: /Lobby/ })).toBe(null);
    expect(
      screen.getByRole("checkbox", { name: "Hall · Second floor" }),
    ).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search Linux players"));
    await user.type(screen.getByLabelText("Search Linux players"), "zzz");
    expect(
      screen.getByText("No Linux player matches this search."),
    ).toBeInTheDocument();
  });

  it("shows the selected count and saves the picked assignments", async () => {
    mockLists();
    const replace = vi
      .spyOn(api, "replacePresentationNetworkAssignments")
      .mockResolvedValue({ assignments: [] });
    vi.spyOn(api, "createPresentationNetwork").mockResolvedValue({
      id: "n1",
    } as never);
    vi.spyOn(api, "presentationNetwork").mockResolvedValue({
      network: { id: "n1" },
      assignments: [],
    } as never);
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Add network" }),
    );
    expect(await screen.findByText("0 of 2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Lobby/ }));
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Display name"), "Staff Wi-Fi");
    await user.type(screen.getByLabelText("SSID"), "staff");
    await user.type(
      screen.getByLabelText("Wi-Fi password / PSK"),
      "correct horse",
    );
    await user.click(screen.getByRole("button", { name: "Save network" }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("n1", ["s1"], "tok"),
    );
  });
});

function renderPanelWithRoutes() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: "/", element: <PresentationNetworksPanel canManage /> },
      { path: "/elsewhere", element: <p>Elsewhere</p> },
    ],
    { initialEntries: ["/"] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

describe("PresentationNetworksPanel unsaved changes", () => {
  it("confirms before Cancel discards a dirty network draft", async () => {
    mockLists();
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Add network" }),
    );
    await user.type(screen.getByLabelText("Display name"), "Staff Wi-Fi");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Discard unsaved network changes?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Display name")).not.toBeInTheDocument(),
    );
  });

  it("warns before a programmatic navigation with a dirty draft", async () => {
    mockLists();
    const user = userEvent.setup();
    const { router } = renderPanelWithRoutes();

    await user.click(
      await screen.findByRole("button", { name: "Add network" }),
    );
    await user.type(screen.getByLabelText("Display name"), "Staff Wi-Fi");
    // The open dialog inerts background links, so departures from here
    // arrive programmatically (command palette, shortcuts, native hosts).
    void router.navigate("/elsewhere");
    const dialog = await screen.findByRole("alertdialog", {
      name: "Discard unsaved network changes?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });
});
