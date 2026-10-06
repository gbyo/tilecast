// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type {
  Screen,
  ScreenGroup,
  SpanPanel,
  SpanStatus,
} from "../../api/types";
import { DisplayGroupDetailPage } from "./DisplayGroupDetailPage";

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf-token", user: { role: "owner" } },
  }),
}));

vi.mock("../../api/client", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    screenGroup: vi.fn(),
    screens: vi.fn(),
    screenReliability: vi.fn(),
    playlists: vi.fn(),
    layouts: vi.fn(),
    spanStatus: vi.fn(),
    updateSpanGeometry: vi.fn(),
  },
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
vi.mock("../../components/DisplayControlGroupActions", () => ({
  DisplayControlGroupActions: () => null,
}));

const members = [
  { id: "s1", name: "Cafeteria East", location: "" },
  { id: "s2", name: "Cafeteria West", location: "" },
];
const baseGroup: ScreenGroup = {
  id: "group-1",
  name: "Cafeteria",
  description: "",
  displayMode: "span",
  playbackEpoch: "e",
  membershipCount: 2,
  screens: members,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const mirrorGroup: ScreenGroup = { ...baseGroup, displayMode: "mirror" };
const panel = (screenId: string, x: number): SpanPanel => ({
  screenId,
  order: 0,
  x,
  y: 0,
  width: 1920,
  height: 1080,
  rotation: 0,
  bezelLeft: 0,
  bezelTop: 0,
  bezelRight: 0,
  bezelBottom: 0,
});
const spanStatus = {
  groupId: "group-1",
  displayMode: "span",
  geometry: {
    canvas: { width: 3840, height: 1080 },
    panels: [panel("s1", 0), panel("s2", 1920)],
  },
  preparations: [],
} as unknown as SpanStatus;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="url">{location.search}</output>;
}

function renderAt(entry: string) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/groups/:id" element={<DisplayGroupDetailPage />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.screenGroup).mockResolvedValue(baseGroup);
  vi.mocked(api.screens).mockResolvedValue({
    items: [] as Screen[],
    total: 0,
  });
  vi.mocked(api.screenReliability).mockResolvedValue({} as never);
  vi.mocked(api.playlists).mockResolvedValue({ items: [] } as never);
  vi.mocked(api.layouts).mockResolvedValue({ items: [] } as never);
  vi.mocked(api.spanStatus).mockResolvedValue(spanStatus);
  vi.mocked(api.updateSpanGeometry).mockResolvedValue(baseGroup);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const prompt = () =>
  screen.findByRole("heading", { name: "Discard unsaved wall changes?" });
const tab = (name: string) => screen.getByRole("tab", { name, hidden: true });

async function editWidth(
  user: ReturnType<typeof userEvent.setup>,
  value: string,
) {
  const width = await screen.findByLabelText("Canvas width");
  await waitFor(() => expect(width).toHaveValue(3840));
  await user.clear(width);
  await user.type(width, value);
  return width;
}

describe("unsaved Span wall protection", () => {
  it("does not prompt when nothing changed, even after the server data loads", async () => {
    const user = userEvent.setup();
    renderAt("/groups/group-1?tab=display");
    await waitFor(() =>
      expect(screen.getByLabelText("Canvas width")).toHaveValue(3840),
    );
    await user.click(tab("Screens"));
    expect(screen.getByTestId("url")).toHaveTextContent("tab=members");
    expect(
      screen.queryByRole("heading", { name: "Discard unsaved wall changes?" }),
    ).not.toBeInTheDocument();
  });

  it("marks a canvas edit dirty and offers keep editing or discard", async () => {
    const user = userEvent.setup();
    renderAt("/groups/group-1?tab=display");
    const width = await editWidth(user, "5000");

    await user.click(tab("Screens"));
    expect(await prompt()).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your Display Group wall configuration has changes that haven't been saved.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("url")).toHaveTextContent("tab=display");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("url")).toHaveTextContent("tab=display");
    expect(width).toHaveValue(5000);
    expect(api.updateSpanGeometry).not.toHaveBeenCalled();

    await user.click(tab("Screens"));
    await user.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    expect(screen.getByTestId("url")).toHaveTextContent("tab=members");
    expect(api.updateSpanGeometry).not.toHaveBeenCalled();

    // The draft is gone: coming back shows the saved wall.
    await user.click(screen.getByRole("tab", { name: "Display" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Canvas width")).toHaveValue(3840),
    );
  });

  it.each([
    [
      "a preset",
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(await screen.findByRole("button", { name: "1 × 2" }));
      },
    ],
    [
      "panel geometry",
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(
          await screen.findByRole("button", { name: /Cafeteria East/ }),
        );
        const x = await screen.findByLabelText("X");
        await user.clear(x);
        await user.type(x, "10");
      },
    ],
    [
      "bezel settings",
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(
          await screen.findByRole("button", { name: /Cafeteria East/ }),
        );
        const left = await screen.findByLabelText("Left");
        await user.clear(left);
        await user.type(left, "4");
      },
    ],
  ])("treats %s as an unsaved change", async (_name, change) => {
    const user = userEvent.setup();
    renderAt("/groups/group-1?tab=display");
    await waitFor(() =>
      expect(screen.getByLabelText("Canvas width")).toHaveValue(3840),
    );
    await change(user);
    await user.click(tab("Playback"));
    expect(await prompt()).toBeInTheDocument();
  });

  it("clears the guard after a successful save", async () => {
    const user = userEvent.setup();
    renderAt("/groups/group-1?tab=display");
    await editWidth(user, "5000");
    await user.click(screen.getByRole("button", { name: "Save wall" }));
    await waitFor(() =>
      expect(api.updateSpanGeometry).toHaveBeenCalledWith(
        "group-1",
        expect.objectContaining({ canvas: { width: 5000, height: 1080 } }),
        "csrf-token",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save wall" }),
      ).not.toBeInTheDocument(),
    );
    await user.click(tab("Screens"));
    expect(screen.getByTestId("url")).toHaveTextContent("tab=members");
    expect(
      screen.queryByRole("heading", { name: "Discard unsaved wall changes?" }),
    ).not.toBeInTheDocument();
  });

  it("clears the guard after an explicit discard", async () => {
    const user = userEvent.setup();
    renderAt("/groups/group-1?tab=display");
    await editWidth(user, "5000");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Canvas width")).toHaveValue(3840),
    );
    await user.click(tab("Screens"));
    expect(screen.getByTestId("url")).toHaveTextContent("tab=members");
  });

  it("guards a newly started Span draft", async () => {
    const user = userEvent.setup();
    vi.mocked(api.screenGroup).mockResolvedValue(mirrorGroup);
    renderAt("/groups/group-1?tab=display");
    await user.click(await screen.findByRole("radio", { name: /Span/ }));
    await screen.findByLabelText("Canvas width");
    await user.click(tab("Playback"));
    expect(await prompt()).toBeInTheDocument();
    expect(api.updateSpanGeometry).not.toHaveBeenCalled();
  });

  it("asks before switching Span back to Mirror with unsaved edits", async () => {
    const user = userEvent.setup();
    renderAt("/groups/group-1?tab=display");
    const width = await editWidth(user, "5000");

    await user.click(screen.getByRole("radio", { name: /Mirror/ }));
    expect(await prompt()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("radio", { name: /Span/ })).toBeChecked();
    expect(width).toHaveValue(5000);

    await user.click(screen.getByRole("radio", { name: /Mirror/ }));
    await user.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    expect(screen.getByRole("radio", { name: /Mirror/ })).toBeChecked();
    expect(screen.queryByLabelText("Canvas width")).not.toBeInTheDocument();
    // Discarding is not saving: the server still has Span until Save display mode.
    expect(api.updateSpanGeometry).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Save display mode" }),
    ).toBeInTheDocument();
    // The wall draft is gone, so leaving no longer prompts.
    await user.click(tab("Screens"));
    expect(screen.getByTestId("url")).toHaveTextContent("tab=members");
  });

  it("switches to Mirror without asking when the wall is unchanged", async () => {
    const user = userEvent.setup();
    renderAt("/groups/group-1?tab=display");
    await waitFor(() =>
      expect(screen.getByLabelText("Canvas width")).toHaveValue(3840),
    );
    await user.click(screen.getByRole("radio", { name: /Mirror/ }));
    expect(screen.getByRole("radio", { name: /Mirror/ })).toBeChecked();
    expect(
      screen.queryByRole("heading", { name: "Discard unsaved wall changes?" }),
    ).not.toBeInTheDocument();
  });
});

describe("Display and Player policy guards", () => {
  it("keeps the Player policy guard and its own wording", async () => {
    const user = userEvent.setup();
    renderAt("/groups/group-1?tab=policy");
    await user.click(
      await screen.findByRole("button", { name: "Make policy dirty" }),
    );
    expect(
      await screen.findByRole("tab", { name: /Player policy.*Unsaved/ }),
    ).toBeInTheDocument();
    await user.click(tab("Display"));
    expect(
      await screen.findByRole("heading", {
        name: "Discard unsaved group settings?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Discard unsaved wall changes?" }),
    ).not.toBeInTheDocument();
  });

  it("does not let a discarded policy edit guard the Display tab, or the reverse", async () => {
    const user = userEvent.setup();
    renderAt("/groups/group-1?tab=policy");
    await user.click(
      await screen.findByRole("button", { name: "Make policy dirty" }),
    );
    await user.click(tab("Display"));
    await user.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    expect(screen.getByTestId("url")).toHaveTextContent("tab=display");

    // Display is clean, so leaving it is free.
    await waitFor(() =>
      expect(screen.getByLabelText("Canvas width")).toHaveValue(3840),
    );
    await user.click(tab("Playback"));
    expect(screen.getByTestId("url")).toHaveTextContent("tab=content");
    expect(
      screen.queryByRole("heading", { name: /Discard unsaved/ }),
    ).not.toBeInTheDocument();

    // A wall edit is then guarded with the wall wording, not the policy one.
    await user.click(tab("Display"));
    await editWidth(user, "4000");
    await user.click(tab("Player policy"));
    expect(await prompt()).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    expect(screen.getByTestId("url")).toHaveTextContent("tab=policy");

    // The wall's flag did not leak onto the policy tab.
    await user.click(tab("Overview"));
    expect(
      screen.queryByRole("heading", { name: /Discard unsaved/ }),
    ).toBeNull();
  });
});
