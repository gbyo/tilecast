// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Screen, Takeover } from "../api/types";
import { mockAuthAs } from "../test/capabilities";
import { ActiveTakeoverBanners, TakeoverDialogs } from "./ScreensPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function takeover(overrides: Partial<Takeover>): Takeover {
  return {
    id: "takeover-1",
    // i18n-ignore: test fixture names
    name: "Tornado Warning",
    description: "",
    playlistId: "playlist-1",
    playlistName: "Shelter instructions",
    status: "active",
    class: "emergency",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    affectedCount: 2,
    activeCount: 2,
    preparingCount: 0,
    failedCount: 0,
    suspendedCount: 0,
    ...overrides,
  };
}

function withQueries(children: ReactNode) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

describe("Takeover priority in Studio", () => {
  it("labels the class, counts waiting screens, and needs a reason to end an emergency", async () => {
    mockAuthAs("owner");
    vi.spyOn(api, "takeovers").mockResolvedValue({
      items: [
        takeover({}),
        takeover({
          id: "takeover-2",
          // i18n-ignore: test fixture name
          name: "Assembly",
          class: "operator",
          activeCount: 0,
          suspendedCount: 2,
        }),
      ],
      total: 2,
    });
    const cancel = vi
      .spyOn(api, "cancelTakeover")
      .mockResolvedValue({ id: "takeover-1", status: "cancelled" });
    render(withQueries(<ActiveTakeoverBanners canManage />));

    expect(await screen.findByText("Emergency")).toBeInTheDocument();
    expect(screen.getByText("Routine")).toBeInTheDocument();
    expect(screen.getByText("2 waiting")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(
      screen.getAllByRole("button", { name: "End takeover" })[0]!,
    );
    const reason = await screen.findByLabelText(
      "Cancellation reason (required)",
    );
    const submit = screen
      .getAllByRole("button", { name: "End takeover" })
      .find((button) => button.getAttribute("type") === "submit")!;
    expect(submit).toBeDisabled();
    await user.type(reason, "Warning expired");
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith(
        "takeover-1",
        "Warning expired",
        "csrf-token",
      ),
    );
  });

  it("warns behind a stronger Takeover and confirms an emergency activation", async () => {
    mockAuthAs("owner");
    vi.spyOn(api, "takeovers").mockResolvedValue({
      items: [takeover({})],
      total: 1,
    });
    vi.spyOn(api, "playlists").mockResolvedValue({
      // i18n-ignore: test fixture name
      items: [{ id: "playlist-2", name: "Assembly slides" }],
    } as unknown as Awaited<ReturnType<typeof api.playlists>>);
    vi.spyOn(api, "screenGroups").mockResolvedValue({
      items: [],
    } as unknown as Awaited<ReturnType<typeof api.screenGroups>>);
    vi.spyOn(api, "settings").mockResolvedValue({
      values: {},
    } as unknown as Awaited<ReturnType<typeof api.settings>>);
    const activate = vi.spyOn(api, "activateTakeover").mockResolvedValue({
      id: "takeover-3",
      status: "active",
      class: "emergency",
      affectedCount: 1,
      suspendedCount: 0,
      expiresAt: new Date().toISOString(),
    });
    const lobby = {
      id: "screen-1",
      // i18n-ignore: test fixture name
      name: "Lobby",
      status: "online",
    } as Screen;
    const gym = {
      id: "screen-2",
      // i18n-ignore: test fixture name
      name: "Gym",
      status: "online",
    } as Screen;
    render(
      withQueries(
        <TakeoverDialogs
          screens={[lobby, gym]}
          open
          onOpenChange={() => undefined}
        />,
      ),
    );

    expect(
      await screen.findByText("1 stronger Takeover is active"),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Emergency" }));
    await waitFor(() =>
      expect(
        screen.queryByText("1 stronger Takeover is active"),
      ).not.toBeInTheDocument(),
    );

    await user.type(screen.getByLabelText("Takeover name"), "Evacuate");
    await user.click(screen.getByRole("combobox", { name: "Playlist" }));
    await user.click(
      await screen.findByRole("option", { name: "Assembly slides" }),
    );
    await user.click(screen.getByRole("checkbox", { name: /Lobby/ }));
    await user.click(screen.getByRole("button", { name: "Activate takeover" }));
    expect(
      await screen.findByText(
        /This emergency Takeover is shown over routine Takeovers/,
      ),
    ).toBeInTheDocument();
    expect(activate).not.toHaveBeenCalled();
    const confirm = screen
      .getAllByRole("button", { name: "Activate takeover" })
      .at(-1)!;
    await user.click(confirm);
    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          class: "emergency",
          name: "Evacuate",
          playlistId: "playlist-2",
          screenIds: ["screen-1"],
        }),
        "csrf-token",
      ),
    );
  });
});
