// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import { toast } from "../components/ui/toast";
import type { Schedule } from "../api/types";
import {
  installEditorTestEnvironment,
  lobby,
  mockAuth,
  mockEditorApi,
  morning,
  playlistRow,
  preflightResult,
  renderEditor,
  setViewport,
} from "./scheduleEditorTestKit";

installEditorTestEnvironment();

const saveButton = () =>
  screen.getByRole("button", { name: /^(Save changes|Create schedule|Save)$/ });
const nameInput = () => screen.getByLabelText("Name");

async function openExisting(role = "owner") {
  mockAuth(role);
  const api = mockEditorApi();
  const view = renderEditor("/schedules/s1");
  await waitFor(() => expect(nameInput()).toHaveValue("Morning Broadcast"));
  return { api, ...view };
}

describe("Schedule editor session", () => {
  it("opens a saved schedule clean, with one heading and nothing to save", async () => {
    await openExisting();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 1, hidden: true }),
    ).toHaveTextContent("Schedule editor: Morning Broadcast");
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    // The detail names its presentation; the whole library is never loaded.
    expect(screen.getByText("Morning Announcements")).toBeInTheDocument();
    expect(await screen.findByText("Libraries")).toBeInTheDocument();
  });

  it("does not read the playlist or layout library, or the fleet, to open", async () => {
    const { api } = await openExisting();
    await screen.findByText("Libraries");
    expect(api.playlistPage).not.toHaveBeenCalled();
    expect(api.layoutPage).not.toHaveBeenCalled();
    expect(api.screens).not.toHaveBeenCalled();
    expect(api.screenGroups).not.toHaveBeenCalled();
  });

  it("is dirty after an edit and clean again when the edit is undone", async () => {
    await openExisting();
    const user = userEvent.setup();
    await user.type(nameInput(), "X");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    await user.type(nameInput(), "{Backspace}");
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("saves with the keyboard shortcut and takes the server's version as the baseline", async () => {
    const { api } = await openExisting();
    api.updateSchedule.mockResolvedValue({
      ...morning,
      name: "Morning Broadcast!",
    });
    const user = userEvent.setup();
    await user.type(nameInput(), "!");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledTimes(1));
    const [id, input, csrf] = api.updateSchedule.mock.calls[0]!;
    expect([id, csrf]).toEqual(["s1", "tok"]);
    expect(input).toMatchObject({
      name: "Morning Broadcast!",
      playlistId: "p1",
      dailyStart: "07:15",
      targets: [{ type: "group", id: "g1" }],
    });
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    // Command+S too.
    await user.type(nameInput(), "?");
    fireEvent.keyDown(window, { key: "S", metaKey: true });
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledTimes(2));
  });

  it("keeps edits made while a save is in flight, and stays dirty", async () => {
    const { api } = await openExisting();
    let finish!: (schedule: Schedule) => void;
    api.updateSchedule.mockReturnValue(
      new Promise<Schedule>((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    await user.type(nameInput(), " A");
    await user.click(saveButton());
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalled());
    expect(screen.getAllByText("Saving…").length).toBeGreaterThan(0);
    // The request carries draft A; the author keeps typing: draft B.
    await user.type(nameInput(), "B");
    await act(async () => {
      finish({ ...morning, name: "Morning Broadcast A" });
      await Promise.resolve();
    });
    // The server's saved A is the baseline; B survives and is still unsaved.
    await waitFor(() =>
      expect(nameInput()).toHaveValue("Morning Broadcast AB"),
    );
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it("stays dirty and offers a retry when a save fails", async () => {
    const { api } = await openExisting();
    api.updateSchedule.mockRejectedValueOnce(
      new ApiError("Display-control schedules need Linux.", 422, "invalid"),
    );
    const user = userEvent.setup();
    await user.type(nameInput(), "X");
    await user.click(saveButton());
    const alert = await screen.findByText(
      "Display-control schedules need Linux.",
    );
    expect(alert).toBeInTheDocument();
    expect(screen.getAllByText("Save failed").length).toBeGreaterThan(0);
    expect(nameInput()).toHaveValue("Morning BroadcastX");
    api.updateSchedule.mockResolvedValueOnce({
      ...morning,
      name: "Morning BroadcastX",
    });
    await user.click(
      within(alert.closest("[role=alert]") as HTMLElement).getByRole("button", {
        name: "Retry",
      }),
    );
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("will not save when there is a problem, and shows it on the first field", async () => {
    const { api } = await openExisting();
    const user = userEvent.setup();
    await user.clear(nameInput());
    await user.click(saveButton());
    expect(api.updateSchedule).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Enter a schedule name."),
    ).toBeInTheDocument();
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
    expect(nameInput()).toHaveAttribute(
      "aria-describedby",
      "schedule-name-error",
    );
    await waitFor(() => expect(nameInput()).toHaveFocus());
    // Revealed and still invalid: Save waits until it is fixed.
    expect(saveButton()).toBeDisabled();
    await user.type(nameInput(), "Morning");
    expect(saveButton()).toBeEnabled();
  });

  it("opens the folded priority section to show its problem", async () => {
    await openExisting();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Conflict handling/ }));
    await user.click(screen.getByRole("radio", { name: /Custom/ }));
    const priority = await screen.findByLabelText("Priority value");
    await user.clear(priority);
    await user.click(saveButton());
    expect(
      await screen.findByText(
        /Priority must be a whole number between -999 and 999/,
      ),
    ).toBeInTheDocument();
  });

  it("lets a viewer read the schedule but not change it", async () => {
    setViewport("desktop");
    const { api } = await openExisting("viewer");
    expect(
      screen.getByText("View only", { selector: "span span" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Save/ }),
    ).not.toBeInTheDocument();
    expect(nameInput()).toHaveAttribute("readonly");
    expect(screen.getByRole("switch", { name: "Enabled" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "More actions" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(api.updateSchedule).not.toHaveBeenCalled();
    // The outcome stays readable.
    expect(await screen.findByText("Next-run check")).toBeInTheDocument();
  });
});

describe("The next-run check and saving", () => {
  it("lets the author save when the check itself fails", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.preflight.mockRejectedValue(
      new ApiError("Server unavailable.", 503, "unavailable"),
    );
    renderEditor("/schedules/s1");
    await waitFor(() => expect(nameInput()).toHaveValue("Morning Broadcast"));
    const user = userEvent.setup();
    await user.type(nameInput(), "!");
    api.updateSchedule.mockResolvedValue({
      ...morning,
      name: "Morning Broadcast!",
    });
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalled());
  });

  it("does not hold Save while a check is still running", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.preflight.mockReturnValue(new Promise(() => undefined));
    renderEditor("/schedules/s1");
    await waitFor(() => expect(nameInput()).toHaveValue("Morning Broadcast"));
    await userEvent.type(nameInput(), "!");
    expect(saveButton()).toBeEnabled();
  });

  it("stops Save when the check found screens that cannot run display control", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.preflight.mockResolvedValue(
      preflightResult({
        unsupportedScreenCount: 2,
        issues: [
          {
            code: "display_control_unsupported",
            severity: "blocking",
            screenCount: 2,
          },
        ],
      }),
    );
    renderEditor("/schedules/s1");
    await waitFor(() => expect(nameInput()).toHaveValue("Morning Broadcast"));
    await userEvent.type(nameInput(), "!");
    await waitFor(() => expect(saveButton()).toBeDisabled());
  });
});

describe("Schedule editor loading", () => {
  it("shows an editor-shaped placeholder, never an empty draft, while loading", async () => {
    mockAuth();
    const api = mockEditorApi();
    let finish!: (schedule: Schedule) => void;
    api.schedule.mockReturnValue(
      new Promise<Schedule>((resolve) => {
        finish = resolve;
      }),
    );
    renderEditor("/schedules/s1");
    expect(
      await screen.findByRole("status", { name: "Loading schedule" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    await act(async () => {
      finish(morning);
      await Promise.resolve();
    });
    expect(
      await screen.findByDisplayValue("Morning Broadcast"),
    ).toBeInTheDocument();
  });

  it("says a missing schedule is missing, without an editor", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.schedule.mockRejectedValue(
      new ApiError("not found", 404, "schedule_not_found"),
    );
    renderEditor("/schedules/gone");
    expect(await screen.findByText("Schedule not found")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("offers a retry when the schedule cannot be read", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.schedule.mockRejectedValueOnce(
      new ApiError("Server unavailable.", 503, "unavailable"),
    );
    renderEditor("/schedules/s1");
    expect(
      await screen.findByText("The schedule could not be loaded"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByDisplayValue("Morning Broadcast"),
    ).toBeInTheDocument();
  });
});

describe("Creating a schedule", () => {
  it("opens with the organization's timezone as part of its starting point", async () => {
    mockAuth();
    const api = mockEditorApi();
    let finish!: (value: { defaultTimezone: string }) => void;
    api.scheduleDefaults.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderEditor("/schedules/new");
    // Nothing is editable until the starting point is settled.
    expect(
      await screen.findByRole("status", { name: "Loading schedule" }),
    ).toBeInTheDocument();
    await act(async () => {
      finish({ defaultTimezone: "Pacific/Auckland" });
      await Promise.resolve();
    });
    expect(await screen.findByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Timezone")).toHaveValue(
      "Auckland (Pacific/Auckland)",
    );
    expect(screen.getByText("Organization default")).toBeInTheDocument();
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create schedule" }),
    ).toBeEnabled();
    // Applying the default was not an edit: leaving asks nothing.
    await userEvent.click(screen.getByRole("link", { name: "away" }));
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });

  it("uses weekdays, nine to five, normal priority, and enabled", async () => {
    mockAuth();
    mockEditorApi();
    renderEditor("/schedules/new");
    expect(await screen.findByLabelText("Starts")).toHaveValue("09:00");
    expect(screen.getByLabelText("Ends")).toHaveValue("17:00");
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])
      expect(screen.getByRole("button", { name: day })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    expect(screen.getByRole("button", { name: "Saturday" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("switch", { name: "Enabled" })).toBeChecked();
    expect(
      screen.getByRole("button", { name: /Conflict handling/ }),
    ).toHaveTextContent("Normal · 0");
  });

  it("preselects the screen it was opened from, without making an edit", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.screen.mockResolvedValue({
      ...lobby,
      syncGroupId: undefined,
    });
    renderEditor("/schedules/new?screen=screen-1");
    expect(await screen.findByText("Lobby")).toBeInTheDocument();
    expect(screen.getByText("Screen")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "away" }));
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });

  it("schedules a grouped screen through its Display Group", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.screen.mockResolvedValue({
      ...lobby,
      syncGroupId: "g1",
      syncGroupName: "Libraries",
    });
    renderEditor("/schedules/new?screen=screen-1");
    expect(await screen.findByText("Libraries")).toBeInTheDocument();
    expect(screen.queryByText("Lobby")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Libraries" }),
    ).toBeInTheDocument();
  });

  it("preselects the Display Group it was opened from", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.screenGroup.mockResolvedValue(libraries_group());
    renderEditor("/schedules/new?group=g1");
    expect(await screen.findByText("Libraries")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "away" }));
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });

  it("opens with no target when the one it was opened from is gone", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.screen.mockRejectedValue(
      new ApiError("missing", 404, "screen_not_found"),
    );
    renderEditor("/schedules/new?screen=gone");
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByText("No targets yet.")).toBeInTheDocument();
  });

  it("does not let a viewer start a schedule", async () => {
    mockAuth("viewer");
    mockEditorApi();
    renderEditor("/schedules/new");
    expect(
      await screen.findByText("You can't create schedules"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("creates a schedule from a chosen playlist and keeps editing it", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.screenGroup.mockResolvedValue(libraries_group());
    api.createSchedule.mockResolvedValue({
      ...morning,
      id: "new-1",
      name: "Weekdays",
    });
    api.schedule.mockResolvedValue({
      ...morning,
      id: "new-1",
      name: "Weekdays",
    });
    const { router } = renderEditor("/schedules/new?group=g1");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Weekdays");
    await user.click(
      screen.getByRole("button", { name: "Choose a Playlist or Layout" }),
    );
    await user.click(
      await screen.findByRole("button", { name: /Morning Announcements/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Use this presentation" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Change" }),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalled());
    expect(api.createSchedule.mock.calls[0]![0]).toMatchObject({
      name: "Weekdays",
      playlistId: "p1",
      type: "weekly",
      timezone: "America/Chicago",
      targets: [{ type: "group", id: "g1" }],
    });
    // Replaced, not pushed: Back does not return to a blank form.
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/schedules/new-1"),
    );
    expect(router.state.historyAction).toBe("REPLACE");
    // Still the editor, now showing the saved schedule, and no discard prompt.
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Weekdays");
  });

  it("carries an edit made while the create was in flight over to the saved schedule", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.screenGroup.mockResolvedValue(libraries_group());
    let finish!: (schedule: Schedule) => void;
    api.createSchedule.mockReturnValue(
      new Promise<Schedule>((resolve) => {
        finish = resolve;
      }),
    );
    api.schedule.mockResolvedValue({
      ...morning,
      id: "new-1",
      name: "Weekdays",
    });
    const { router } = renderEditor("/schedules/new?group=g1");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Weekdays");
    await user.click(
      screen.getByRole("button", { name: "Choose a Playlist or Layout" }),
    );
    await user.click(
      await screen.findByRole("button", { name: /Morning Announcements/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Use this presentation" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Create schedule" }),
    );
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalled());
    await user.type(screen.getByLabelText("Name"), " Edited");
    api.schedule.mockResolvedValue({
      ...morning,
      id: "new-1",
      name: "Weekdays",
    });
    await act(async () => {
      finish({ ...morning, id: "new-1", name: "Weekdays" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/schedules/new-1"),
    );
    expect(
      await screen.findByDisplayValue("Weekdays Edited"),
    ).toBeInTheDocument();
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });
});

describe("Leaving the editor", () => {
  it("leaves a clean editor without asking", async () => {
    await openExisting();
    await userEvent.click(screen.getByRole("link", { name: "away" }));
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });

  it("asks before discarding edits, and names the schedule", async () => {
    await openExisting();
    const user = userEvent.setup();
    await user.type(nameInput(), "X");
    await user.click(screen.getByRole("link", { name: "away" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Discard unsaved changes?"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Morning BroadcastX/)).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.queryByText("Elsewhere")).not.toBeInTheDocument();
    expect(nameInput()).toHaveValue("Morning BroadcastX");
    await user.click(screen.getByRole("link", { name: "away" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });

  it("does not ask again once the edits are saved", async () => {
    const { api } = await openExisting();
    api.updateSchedule.mockResolvedValue({
      ...morning,
      name: "Morning BroadcastX",
    });
    const user = userEvent.setup();
    await user.type(nameInput(), "X");
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    await user.click(screen.getByRole("link", { name: "away" }));
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });
});

describe("Deleting a schedule", () => {
  async function openMenu() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    return user;
  }

  it("is offered only to someone who manages schedules", async () => {
    await openExisting("viewer");
    expect(
      screen.queryByRole("button", { name: "More actions" }),
    ).not.toBeInTheDocument();
  });

  it("names the schedule, explains what happens, and can be cancelled", async () => {
    const { api } = await openExisting();
    const user = await openMenu();
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete schedule" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Delete “Morning Broadcast”?"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/stop playing/)).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Keep schedule" }),
    );
    expect(api.deleteSchedule).not.toHaveBeenCalled();
    expect(nameInput()).toBeInTheDocument();
  });

  it("deletes, returns to the list, and does not ask to discard unsaved edits", async () => {
    const { api } = await openExisting();
    const user = userEvent.setup();
    await user.type(nameInput(), "X");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete schedule" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete schedule",
      }),
    );
    await waitFor(() =>
      expect(api.deleteSchedule).toHaveBeenCalledWith("s1", "tok"),
    );
    expect(await screen.findByText("Schedule list")).toBeInTheDocument();
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
  });

  it("leaves the editor intact and says so when the delete fails", async () => {
    const { api } = await openExisting();
    const toasts = vi.spyOn(toast, "add");
    api.deleteSchedule.mockRejectedValue(
      new ApiError("The server refused.", 500, "failed"),
    );
    const user = await openMenu();
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete schedule" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete schedule",
      }),
    );
    await waitFor(() =>
      expect(toasts).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "The schedule could not be deleted.",
          description: "The server refused.",
          type: "error",
        }),
      ),
    );
    expect(nameInput()).toHaveValue("Morning Broadcast");
    expect(screen.queryByText("Schedule list")).not.toBeInTheDocument();
  });

  it("offers to discard unsaved changes from the same menu", async () => {
    await openExisting();
    const user = userEvent.setup();
    await user.type(nameInput(), "X");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Discard unsaved changes" }),
    );
    expect(nameInput()).toHaveValue("Morning Broadcast");
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
});

function libraries_group() {
  return {
    id: "g1",
    name: "Libraries",
    membershipCount: 4,
    screens: [],
  } as never;
}

// The playlist row and library are fixtures shared with other tests.
void playlistRow;
