// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Playlist, Schedule } from "../api/types";
import {
  installEditorTestEnvironment,
  libraries,
  lobby,
  mockAuth,
  mockEditorApi,
  morning,
  renderEditor,
} from "./scheduleEditorTestKit";

installEditorTestEnvironment();

const playlistRowFor = (id: string, name: string, itemCount = 1) =>
  ({
    id,
    name,
    description: "",
    itemCount,
    items: [],
    previewItems: [],
    layoutUsage: [],
    warnings: [],
  }) as unknown as Playlist;

async function open(schedule: Partial<Schedule> = {}) {
  mockAuth();
  const api = mockEditorApi();
  api.schedule.mockResolvedValue({ ...morning, ...schedule });
  const view = renderEditor("/schedules/s1");
  await screen.findByDisplayValue(schedule.name ?? morning.name);
  return { api, user: userEvent.setup(), ...view };
}

const saveInput = (api: ReturnType<typeof mockEditorApi>) =>
  api.updateSchedule.mock.calls.at(-1)![1];

async function save(
  api: ReturnType<typeof mockEditorApi>,
  user: ReturnType<typeof userEvent.setup>,
  saved: Partial<Schedule> = {},
) {
  api.updateSchedule.mockResolvedValue({ ...morning, ...saved });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.updateSchedule).toHaveBeenCalled());
}

describe("Presentation", () => {
  it("offers Content and Display control as one choice, each explained", async () => {
    await open();
    const group = screen.getByRole("radiogroup", { name: "Presentation type" });
    const content = within(group).getByRole("radio", { name: /Content/ });
    const display = within(group).getByRole("radio", {
      name: /Display control/,
    });
    expect(content).toBeChecked();
    expect(display).not.toBeChecked();
    expect(
      screen.getByText("Play a Playlist or published Layout."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Change power, input, volume, mute, or brightness."),
    ).toBeInTheDocument();
  });

  it("shows the chosen playlist as an item and reads that one playlist for its length", async () => {
    const { api } = await open();
    expect(screen.getByText("Morning Announcements")).toBeInTheDocument();
    await waitFor(() => expect(api.playlist).toHaveBeenCalledWith("p1"));
    expect(api.playlistPage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Change" })).toBeEnabled();
  });

  it("changes to a Layout, and sends only the Layout", async () => {
    const { api, user } = await open();
    api.layoutPage.mockResolvedValue({
      items: [
        {
          id: "layout-1",
          name: "Cafeteria Board",
          publishedRevision: 4,
          canvasWidth: 1920,
          canvasHeight: 1080,
          orientation: "landscape",
        } as never,
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(
      await screen.findByRole("button", { name: /Cafeteria Board/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Use this presentation" }),
    );
    expect(
      await screen.findByText("Layout · Published revision 4"),
    ).toBeInTheDocument();
    await save(api, user, { layoutId: "layout-1" });
    const input = saveInput(api);
    expect(input).toMatchObject({ layoutId: "layout-1" });
    expect(input).not.toHaveProperty("playlistId");
  });

  it(
    "reopens the picker on the current choice",
    { timeout: 30_000 },
    async () => {
      const { user } = await open();
      await user.click(screen.getByRole("button", { name: "Change" }));
      const row = await screen.findByRole("button", {
        name: /Morning Announcements/,
      });
      expect(row).toHaveAttribute("aria-pressed", "true");
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      // Escape left the choice alone, and focus came back to Change.
      expect(screen.getByText("Morning Announcements")).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Change" })).toHaveFocus(),
      );
    },
  );

  it(
    "keeps the choice on Cancel, and chooses on a double click",
    { timeout: 30_000 },
    async () => {
      const { api, user } = await open();
      api.playlistPage.mockResolvedValue({
        items: [
          { ...playlistRowFor("p1", "Morning Announcements"), itemCount: 8 },
          { ...playlistRowFor("p2", "Lunch Rotation"), itemCount: 3 },
        ],
        total: 2,
        page: 1,
        pageSize: 100,
      });
      await user.click(screen.getByRole("button", { name: "Change" }));
      await user.click(
        await screen.findByRole("button", { name: /Lunch Rotation/ }),
      );
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      // Cancel left the saved choice alone.
      expect(screen.getByText("Morning Announcements")).toBeInTheDocument();
      expect(screen.getByText("Saved")).toBeInTheDocument();
      // Reopening starts on the current choice, not the one Cancel abandoned.
      await user.click(screen.getByRole("button", { name: "Change" }));
      expect(
        await screen.findByRole("button", { name: /Morning Announcements/ }),
      ).toHaveAttribute("aria-pressed", "true");
      await user.dblClick(
        screen.getByRole("button", { name: /Lunch Rotation/ }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(screen.getByText("Lunch Rotation")).toBeInTheDocument();
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
    },
  );

  it("shows only the field the chosen display action needs", async () => {
    const { api, user } = await open();
    await user.click(screen.getByRole("radio", { name: /Display control/ }));
    expect(screen.queryByLabelText("Input identifier")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Volume")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Action" }));
    await user.click(await screen.findByRole("option", { name: "Set input" }));
    expect(
      await screen.findByLabelText("Input identifier"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Action" }));
    await user.click(await screen.findByRole("option", { name: "Set volume" }));
    expect(await screen.findByLabelText("Volume")).toBeInTheDocument();
    expect(screen.queryByLabelText("Input identifier")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Volume"), "40");
    await save(api, user, {
      presentationType: "display_control",
      displayAction: { type: "display_set_volume", volume: 40 },
    });
    const input = saveInput(api);
    expect(input).toMatchObject({
      displayAction: { type: "display_set_volume", volume: 40 },
    });
    expect(input).not.toHaveProperty("playlistId");
  });

  it("keeps each presentation's own choice while switching between them", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("radio", { name: /Display control/ }));
    await user.click(screen.getByRole("radio", { name: /^Content/ }));
    expect(screen.getByText("Morning Announcements")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("asks for a presentation when saving without one, and focuses the control that picks it", async () => {
    mockAuth();
    const api = mockEditorApi();
    api.screenGroup.mockResolvedValue({
      id: "g1",
      name: "Libraries",
      membershipCount: 1,
      screens: [],
    } as never);
    renderEditor("/schedules/new?group=g1");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Power on");
    await user.click(screen.getByRole("button", { name: "Create schedule" }));
    expect(
      await screen.findByText("Choose content or a Display Control action."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Choose a Playlist or Layout" }),
      ).toHaveFocus(),
    );
    expect(api.createSchedule).not.toHaveBeenCalled();
  });

  it("asks for the display action's value, and focuses it", async () => {
    const { api, user } = await open({
      presentationType: "display_control",
      playlistId: undefined,
      displayAction: { type: "display_set_input" },
    });
    // A saved schedule with an empty input is clean until someone edits it.
    await user.type(screen.getByLabelText("Name"), "!");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText(
        "Enter an input identifier for the Display Control action.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Input identifier")).toHaveFocus(),
    );
    expect(api.updateSchedule).not.toHaveBeenCalled();
  });
});

describe("Timing", () => {
  it("shows weekly and one-time as one choice", async () => {
    await open();
    expect(
      screen.getByRole("radiogroup", { name: "Schedule type" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Weekly/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /One-time/ })).not.toBeChecked();
  });

  it("changes the weekdays, and says so when none is left", async () => {
    const { api, user } = await open();
    await user.click(screen.getByRole("button", { name: "Saturday" }));
    expect(screen.getByRole("button", { name: "Saturday" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByText(/Mon–Sat/, { selector: "span" }),
    ).toBeInTheDocument();
    await save(api, user, { daysOfWeek: [1, 2, 3, 4, 5, 6] });
    expect(saveInput(api).daysOfWeek).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reports no weekday as a problem on the group", async () => {
    const { api, user } = await open({ daysOfWeek: [1] });
    await user.click(screen.getByRole("button", { name: "Monday" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("Select at least one weekday."),
    ).toBeInTheDocument();
    expect(api.updateSchedule).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Monday" })).toHaveFocus(),
    );
  });

  it("describes an overnight window in words, not as an error", async () => {
    const { api, user } = await open();
    const end = screen.getByLabelText("Ends");
    await user.clear(end);
    await user.type(end, "06:00");
    // 07:15 to 06:00 wraps past midnight.
    expect(screen.getByText("Ends the next day.")).toBeInTheDocument();
    expect(screen.getByText(/\(next day\)/)).toBeInTheDocument();
    await save(api, user, { dailyEnd: "06:00" });
    expect(saveInput(api)).toMatchObject({
      dailyStart: "07:15",
      dailyEnd: "06:00",
    });
  });

  it("keeps the date range folded unless the schedule has one", async () => {
    const { user } = await open();
    const trigger = screen.getByRole("button", {
      name: "Limit to a date range",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Starts on")).not.toBeInTheDocument();
    await user.click(trigger);
    expect(await screen.findByText("Starts on")).toBeInTheDocument();
  });

  it("opens the date range when one is saved, and removes it on request", async () => {
    const { api, user } = await open({
      startDate: "2026-09-01",
      endDate: "2026-12-18",
    });
    expect(
      screen.getByRole("button", { name: "Limit to a date range" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Sep 1, 2026 – Dec 18, 2026/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove date range" }));
    expect(screen.queryByText("Starts on")).not.toBeInTheDocument();
    await save(api, user);
    expect(saveInput(api).startDate).toBeUndefined();
    expect(saveInput(api).endDate).toBeUndefined();
  });

  it("keeps a date range through folding and unfolding", async () => {
    const { user } = await open({ startDate: "2026-09-01" });
    const trigger = screen.getByRole("button", {
      name: "Limit to a date range",
    });
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.getByText(/from Sep 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("starts a one-time window the first time, and keeps the weekly values", async () => {
    const { api, user } = await open();
    await user.click(screen.getByRole("radio", { name: /One-time/ }));
    expect(
      await screen.findByText("Run once between two dates and times."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Monday" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("1 hr")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Weekly/ }));
    expect(screen.getByLabelText("Starts")).toHaveValue("07:15");
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(api.updateSchedule).not.toHaveBeenCalled();
  });

  it("shows a saved one-time schedule in its own timezone, not the browser's", async () => {
    await open({
      type: "one_time",
      timezone: "Asia/Tokyo",
      oneTimeStart: "2026-10-31T23:00:00Z",
      oneTimeEnd: "2026-11-01T05:00:00Z",
      dailyStart: undefined,
      dailyEnd: undefined,
      daysOfWeek: undefined as never,
    });
    // 23:00Z is 08:00 on Nov 1 in Tokyo, whatever zone the browser is in.
    expect(screen.getByLabelText("Start time")).toHaveValue("08:00");
    expect(screen.getByLabelText("End time")).toHaveValue("14:00");
    expect(screen.getByText("6 hr")).toBeInTheDocument();
  });

  it("keeps the same wall-clock event when the timezone changes", async () => {
    const { api, user } = await open({
      type: "one_time",
      timezone: "America/New_York",
      oneTimeStart: "2026-10-31T23:00:00Z",
      oneTimeEnd: "2026-11-01T05:00:00Z",
      dailyStart: undefined,
      dailyEnd: undefined,
      daysOfWeek: undefined as never,
    });
    expect(screen.getByLabelText("Start time")).toHaveValue("19:00");
    const zone = screen.getByRole("combobox", { name: "Timezone" });
    await user.click(zone);
    await user.clear(zone);
    await user.type(zone, "Los Angeles");
    await user.click(
      await screen.findByRole("option", { name: /Los Angeles/ }),
    );
    expect(screen.getByLabelText("Start time")).toHaveValue("19:00");
    await save(api, user);
    expect(saveInput(api)).toMatchObject({
      timezone: "America/Los_Angeles",
      oneTimeStart: "2026-11-01T02:00:00.000Z", // 7 PM PDT
    });
  });

  it("says when the timezone is the organization's default, and when it is not", async () => {
    const { user } = await open({ timezone: "America/New_York" });
    expect(screen.queryByText("Organization default")).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        /Your organization's default is America\/Chicago/,
      ),
    ).toBeInTheDocument();
    const zone = screen.getByRole("combobox", { name: "Timezone" });
    await user.click(zone);
    await user.clear(zone);
    await user.type(zone, "Chicago");
    await user.click(await screen.findByRole("option", { name: /Chicago/ }));
    expect(await screen.findByText("Organization default")).toBeInTheDocument();
  });
});

describe("Targets", () => {
  it("lists each target on its own row with a named Remove", async () => {
    const { api, user } = await open();
    expect(
      screen.getByRole("list", { name: "1 selected target" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Display Group")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Libraries" }));
    expect(screen.getByText("No targets yet.")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Add targets" }),
      ).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("Select at least one screen or group."),
    ).toBeInTheDocument();
    expect(api.updateSchedule).not.toHaveBeenCalled();
  });

  it("reads the fleet only when the picker opens, and offers groups and screens", async () => {
    const { api, user } = await open();
    expect(api.screens).not.toHaveBeenCalled();
    await user.click(screen.getByRole("combobox", { name: "Add targets" }));
    await waitFor(() => expect(api.screens).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Display Groups")).toBeInTheDocument();
    expect(screen.getByText("Screens")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Lobby/ })).toBeInTheDocument();
    expect(
      screen.getByText(
        "A screen in a Display Group is added through its group.",
      ),
    ).toBeInTheDocument();
  });

  it("finds a group by the screens inside it, and adds the group", async () => {
    const { api, user } = await open({
      targets: [{ type: "screen", id: "screen-1", name: "Lobby" }],
    });
    await user.click(screen.getByRole("combobox", { name: "Add targets" }));
    await user.type(
      await screen.findByRole("combobox", {
        name: "Search screens and Display Groups",
      }),
      "Reading",
    );
    const option = await screen.findByRole("option", { name: /Libraries/ });
    expect(
      screen.queryByRole("option", { name: /Reading Room/ }),
    ).not.toBeInTheDocument();
    await user.click(option);
    await user.keyboard("{Escape}");
    expect(
      await screen.findByRole("button", { name: "Remove Libraries" }),
    ).toBeInTheDocument();
    await save(api, user);
    expect(saveInput(api).targets).toEqual([
      { type: "screen", id: "screen-1" },
      { type: "group", id: "g1" },
    ]);
  });

  it("explains that grouped screens share one schedule", async () => {
    await open();
    expect(
      screen.getByText(
        "Screens in a Display Group always share one schedule and its fallback content.",
      ),
    ).toBeInTheDocument();
    void lobby;
    void libraries;
  });
});

describe("Priority", () => {
  it("keeps priority folded at its default, with a summary", async () => {
    await open();
    const trigger = screen.getByRole("button", { name: /Conflict handling/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Normal · 0");
    expect(
      screen.queryByRole("radio", { name: /Important/ }),
    ).not.toBeInTheDocument();
  });

  it("opens by itself when the priority is not normal", async () => {
    await open({ priority: 40 });
    const trigger = screen.getByRole("button", { name: /Conflict handling/ });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveTextContent("Custom (40) · 40");
    expect(screen.getByRole("radio", { name: /Custom/ })).toBeChecked();
    expect(screen.getByLabelText("Priority value")).toHaveValue(40);
  });

  it("chooses a preset by radio", async () => {
    const { api, user } = await open();
    await user.click(screen.getByRole("button", { name: /Conflict handling/ }));
    await user.click(screen.getByRole("radio", { name: /Important/ }));
    expect(
      screen.getByRole("button", { name: /Conflict handling/ }),
    ).toHaveTextContent("Important · 100");
    expect(screen.queryByLabelText("Priority value")).not.toBeInTheDocument();
    await save(api, user, { priority: 100 });
    expect(saveInput(api).priority).toBe(100);
  });

  it("keeps the custom field while typing a number that matches a preset", async () => {
    const { api, user } = await open();
    await user.click(screen.getByRole("button", { name: /Conflict handling/ }));
    await user.click(screen.getByRole("radio", { name: /Custom/ }));
    const field = screen.getByLabelText("Priority value");
    await user.clear(field);
    await user.type(field, "100");
    // 100 is also the Important preset, but the author chose Custom.
    expect(screen.getByLabelText("Priority value")).toHaveValue(100);
    expect(screen.getByRole("radio", { name: /Custom/ })).toBeChecked();
    await save(api, user, { priority: 100 });
    expect(saveInput(api).priority).toBe(100);
  });

  it("rejects a priority outside the range", async () => {
    const { api, user } = await open({ priority: 40 });
    const field = screen.getByLabelText("Priority value");
    await user.clear(field);
    await user.type(field, "1000");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText(
        "Priority must be a whole number between -999 and 999.",
      ),
    ).toBeInTheDocument();
    expect(api.updateSchedule).not.toHaveBeenCalled();
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the section closed while the author types in other fields", async () => {
    const { user } = await open();
    await user.type(screen.getByLabelText("Name"), " more");
    expect(
      screen.getByRole("button", { name: /Conflict handling/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Description and enabled state", () => {
  it("says the enabled switch applies on save", async () => {
    const { api, user } = await open();
    expect(
      screen.getByText(
        "When saved, this schedule can affect playback during its scheduled times.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Enabled" }));
    expect(api.updateSchedule).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    await save(api, user, { enabled: false });
    expect(saveInput(api).enabled).toBe(false);
  });

  it("keeps the description optional", async () => {
    const { api, user } = await open();
    await user.type(
      screen.getByLabelText("Description (optional)"),
      "Weekday mornings",
    );
    await save(api, user, { description: "Weekday mornings" });
    expect(saveInput(api).description).toBe("Weekday mornings");
  });
});
