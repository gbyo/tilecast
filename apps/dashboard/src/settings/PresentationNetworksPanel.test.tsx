// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type {
  PresentationNetwork,
  PresentationNetworkDetail,
  PresentationNetworkList,
} from "../api/types";
import "../i18n";
import { PresentationNetworksPanel } from "./PresentationNetworksPanel";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(), dialog: null }),
}));

function network(id: string, name: string): PresentationNetwork {
  return {
    id,
    name,
    ssid: name.toLowerCase().replaceAll(" ", "-"),
    hidden: false,
    security: "wpa_psk",
    securityLabel: "WPA2/WPA3 Personal",
    auth: {},
    credentialSet: true,
    configRevision: 1,
    assignedScreens: 0,
    createdAt: "2026-09-29T12:00:00Z",
    updatedAt: "2026-09-29T12:00:00Z",
  };
}

function list(items: PresentationNetwork[]): PresentationNetworkList {
  return {
    items,
    credentialsAvailable: true,
    credentialsUnavailableReason: "",
    supportedSecurity: [
      { value: "wpa_psk", label: "WPA2/WPA3 Personal", enterprise: false },
    ],
  };
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <PresentationNetworksPanel canManage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PresentationNetworksPanel", () => {
  it("never renders the previous network draft when the next detail request fails", async () => {
    const first = network("network-a", "Network A");
    const second = network("network-b", "Network B");
    vi.spyOn(api, "presentationNetworks").mockResolvedValue(list([first, second]));
    vi.spyOn(api, "screens").mockResolvedValue({
      items: [],
      total: 0,
    } as Awaited<ReturnType<typeof api.screens>>);
    vi.spyOn(api, "presentationNetwork").mockImplementation(async (id) => {
      if (id === first.id) {
        return {
          network: first,
          assignments: [],
        } satisfies PresentationNetworkDetail;
      }
      throw new Error("Network B detail failed");
    });

    const user = userEvent.setup();
    renderPanel();

    const editButtons = await screen.findAllByRole("button", { name: "Edit" });
    await user.click(editButtons[0]);
    expect(await screen.findByDisplayValue("Network A")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click((await screen.findAllByRole("button", { name: "Edit" }))[1]);

    expect(await screen.findByText(/Network B detail failed/)).toBeTruthy();
    expect(screen.queryByDisplayValue("Network A")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save network" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Try again." })).toBeTruthy();
  });

  it("retries assignments against the already-created network instead of creating a duplicate", async () => {
    const created = network("network-created", "Event Wi-Fi");
    vi.spyOn(api, "presentationNetworks").mockResolvedValue(list([]));
    vi.spyOn(api, "screens").mockResolvedValue({
      items: [],
      total: 0,
    } as Awaited<ReturnType<typeof api.screens>>);
    const create = vi
      .spyOn(api, "createPresentationNetwork")
      .mockResolvedValue(created);
    const update = vi
      .spyOn(api, "updatePresentationNetwork")
      .mockResolvedValue(created);
    const assignments = vi
      .spyOn(api, "replacePresentationNetworkAssignments")
      .mockRejectedValueOnce(new Error("Assignment save failed"))
      .mockResolvedValueOnce(
        { assignments: [] } as Awaited<
          ReturnType<typeof api.replacePresentationNetworkAssignments>
        >,
      );

    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Add network" }),
    );
    await user.type(screen.getByLabelText("Display name"), "Event Wi-Fi");
    await user.type(screen.getByLabelText("SSID"), "event-wifi");
    await user.type(
      screen.getByLabelText("Wi-Fi password / PSK"),
      "correct horse battery staple",
    );
    await user.click(screen.getByRole("button", { name: "Save network" }));

    expect(await screen.findByText("Assignment save failed")).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Save network" }));
    await waitFor(() => expect(assignments).toHaveBeenCalledTimes(2));

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      created.id,
      expect.objectContaining({
        name: "Event Wi-Fi",
        ssid: "event-wifi",
      }),
      "csrf",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Add Presentation Network" }),
      ).toBeNull(),
    );
  });
});
