// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { ScreenGroup } from "../../api/types";
import { ScreenPlaybackCard } from "./ScreenPlaybackCard";
import {
  assignmentFixture,
  planFixture,
  selectionFixture,
} from "./playbackFixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCard(
  props: Partial<Parameters<typeof ScreenPlaybackCard>[0]> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onExplain = vi.fn();
  const onOpenDiagnostics = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScreenPlaybackCard
          screenId="screen-1"
          screenName="HS Cafeteria North"
          screenStatus="online"
          assignment={assignmentFixture({
            playlistId: "playlist-9",
            playlistName: "Morning Announcements",
          })}
          assignmentLoading={false}
          assignmentError={null}
          plan={planFixture()}
          planLoading={false}
          planError={null}
          canManage
          csrfToken="csrf"
          onExplain={onExplain}
          onOpenDiagnostics={onOpenDiagnostics}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, onExplain, onOpenDiagnostics };
}

describe("ScreenPlaybackCard expected now", () => {
  it("shows the scheduled selection with its source and window", () => {
    renderCard();
    expect(screen.getByText("Expected now")).toBeVisible();
    expect(screen.getByText("Lunch Menu")).toBeVisible();
    expect(screen.getByText("Schedule")).toBeVisible();
    expect(screen.getByText(/Selected by Lunch Service/)).toBeVisible();
    expect(screen.getByText(/Player: playing/)).toBeVisible();
  });

  it("shows default playback when nothing overrides the assignment", () => {
    renderCard({
      plan: planFixture({
        selected: selectionFixture({
          source: "assignment",
          name: "Morning Announcements",
          scheduleName: undefined,
          selectionId: undefined,
          reason: "assigned_fallback",
        }),
      }),
    });
    expect(screen.getByText("Default")).toBeVisible();
    expect(
      screen.getByText(
        "No schedule or temporary presentation currently overrides it",
      ),
    ).toBeVisible();
  });

  it("labels takeover selections as overriding normal playback", () => {
    renderCard({
      plan: planFixture({
        selected: selectionFixture({
          source: "takeover",
          name: "Emergency Instructions",
          reason: "active_takeover",
        }),
      }),
    });
    expect(screen.getByText("Takeover")).toBeVisible();
    expect(
      screen.getByText("Takeover is currently overriding normal playback"),
    ).toBeVisible();
  });

  it("labels show-now selections as overriding schedules and defaults", () => {
    renderCard({
      plan: planFixture({
        selected: selectionFixture({
          source: "quick_present",
          name: "Guest Slides",
          reason: "active_quick_present",
        }),
      }),
    });
    expect(screen.getByText("Show Now")).toBeVisible();
    expect(
      screen.getByText(
        "A Show Now presentation is currently overriding schedules and default content",
      ),
    ).toBeVisible();
  });

  it("reports an offline player with its last confirmation", () => {
    renderCard({
      screenStatus: "offline",
      lastContactAt: "2026-09-28T13:00:00Z",
      assignment: assignmentFixture({
        playbackState: undefined,
        playlistId: "playlist-9",
        playlistName: "Morning Announcements",
      }),
    });
    expect(screen.getByText(/Player: Offline/)).toBeVisible();
    expect(screen.getByText(/last confirmed/)).toBeVisible();
  });

  it("opens the explanation panel from Why this?", async () => {
    const interaction = userEvent.setup();
    const { onExplain } = renderCard();
    await interaction.click(screen.getByRole("button", { name: "Why this?" }));
    expect(onExplain).toHaveBeenCalledTimes(1);
  });

  it("surfaces playback faults without hiding the selection", () => {
    renderCard({
      assignment: assignmentFixture({
        playlistId: "playlist-9",
        playlistName: "Morning Announcements",
        lastPlaybackError: "decoder stalled",
        configurationError: "rejected by player",
      }),
    });
    expect(screen.getByText("Lunch Menu")).toBeVisible();
    expect(screen.getByText("decoder stalled")).toBeVisible();
    expect(screen.getByText("rejected by player")).toBeVisible();
  });
});

describe("ScreenPlaybackCard default content", () => {
  it("shows an empty state when no default content exists", () => {
    renderCard({ assignment: assignmentFixture() });
    expect(screen.getByText("No default content")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Choose default" }),
    ).toBeVisible();
  });

  it("links a group-managed default to its display group", () => {
    vi.spyOn(api, "screenGroup").mockResolvedValue({
      membershipCount: 6,
    } as ScreenGroup);
    renderCard({
      assignment: assignmentFixture({
        playlistId: "playlist-9",
        playlistName: "Morning Announcements",
        groups: [{ id: "group-1", name: "Cafeteria Displays" }],
      }),
    });
    expect(screen.getByText("Group-managed")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Cafeteria Displays" }),
    ).toHaveAttribute("href", "/groups/group-1");
    expect(
      screen.getByRole("button", { name: "Change for Cafeteria Displays" }),
    ).toBeVisible();
  });

  it("confirms the exact scope before changing a group default", async () => {
    const interaction = userEvent.setup();
    vi.spyOn(api, "screenGroup").mockResolvedValue({
      membershipCount: 6,
    } as ScreenGroup);
    const assign = vi
      .spyOn(api, "assignPlaylist")
      .mockResolvedValue({} as never);
    vi.spyOn(api, "playlistPage").mockResolvedValue({
      items: [{ id: "playlist-2", name: "Evening News", itemCount: 4 }],
      total: 1,
      page: 1,
      pageSize: 50,
    } as never);
    vi.spyOn(api, "layoutPage").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    renderCard({
      assignment: assignmentFixture({
        playlistId: "playlist-9",
        playlistName: "Morning Announcements",
        groups: [{ id: "group-1", name: "Cafeteria Displays" }],
      }),
    });

    await interaction.click(
      screen.getByRole("button", { name: "Change for Cafeteria Displays" }),
    );
    await interaction.click(
      await screen.findByRole("button", { name: /Evening News/ }),
    );
    await interaction.click(
      screen.getByRole("button", { name: "Set default" }),
    );

    expect(
      await screen.findByText("Change default content for Cafeteria Displays?"),
    ).toBeVisible();
    expect(
      screen.getByText(/contains 6 screens.*including HS Cafeteria North/s),
    ).toBeVisible();
    await interaction.click(
      screen.getByRole("button", { name: "Change 6 screens" }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledWith("screen-1", "playlist-2", "csrf");
  });

  it("commits a standalone change without a scope confirmation", async () => {
    const interaction = userEvent.setup();
    const assign = vi
      .spyOn(api, "assignPlaylist")
      .mockResolvedValue({} as never);
    vi.spyOn(api, "playlistPage").mockResolvedValue({
      items: [{ id: "playlist-2", name: "Evening News", itemCount: 4 }],
      total: 1,
      page: 1,
      pageSize: 50,
    } as never);
    vi.spyOn(api, "layoutPage").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    renderCard({
      assignment: assignmentFixture({
        playlistId: "playlist-9",
        playlistName: "Morning Announcements",
      }),
    });

    await interaction.click(
      screen.getByRole("button", { name: "Change default" }),
    );
    await interaction.click(
      await screen.findByRole("button", { name: /Evening News/ }),
    );
    await interaction.click(
      screen.getByRole("button", { name: "Set default" }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText(/Change default content for/),
    ).not.toBeInTheDocument();
  });

  it("removes a standalone default from the overflow menu", async () => {
    const unassign = vi
      .spyOn(api, "unassignPlaylist")
      .mockResolvedValue({} as never);
    renderCard({
      assignment: assignmentFixture({
        playlistId: "playlist-9",
        playlistName: "Morning Announcements",
      }),
    });
    fireEvent.click(
      screen.getByRole("button", { name: "More default content actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove default" }),
    );
    await waitFor(() => expect(unassign).toHaveBeenCalledTimes(1));
    expect(unassign).toHaveBeenCalledWith("screen-1", "csrf");
  });

  it("hides mutation controls from viewers", () => {
    renderCard({
      canManage: false,
      assignment: assignmentFixture({
        playlistId: "playlist-9",
        playlistName: "Morning Announcements",
      }),
    });
    expect(
      screen.queryByRole("button", { name: "Change default" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Morning Announcements")).toBeVisible();
  });
});
