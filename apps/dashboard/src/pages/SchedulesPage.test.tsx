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
import { api, ApiError } from "../api/client";
import type { Schedule, ScheduleListParams } from "../api/types";
import { toast } from "../components/ui/toast";
import { scheduleKeys } from "../data/schedules";
import { SchedulesPage } from "./SchedulesPage";

const auth = vi.hoisted(() => ({ role: "administrator" }));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf-token",
      user: { id: "user-1", role: auth.role },
    },
  }),
}));

const COMPACT_QUERY = "(max-width: 639px)";

function stubViewport(compact: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: compact && query === COMPACT_QUERY,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function schedule(id: string, name: string, extra: Partial<Schedule> = {}) {
  return {
    id,
    name,
    description: "",
    playlistId: "playlist-1",
    playlistName: "Morning Announcements",
    presentationType: "playlist",
    type: "weekly",
    timezone: "America/Chicago",
    priority: 40,
    specificity: 0,
    enabled: true,
    dailyStart: "07:15",
    dailyEnd: "08:15",
    daysOfWeek: [1, 2, 3, 4, 5],
    targets: [
      { type: "group", id: "g1", name: "Libraries" },
      { type: "group", id: "g2", name: "Front Office" },
    ],
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    ...extra,
  } as Schedule;
}

const morning = schedule("s-morning", "Morning Broadcast", {
  description: "Announcements before first period.",
});
const lunch = schedule("s-lunch", "Lunch Service", {
  presentationType: "layout",
  playlistName: "Menu board",
  layoutName: "Menu board",
  priority: 50,
  dailyStart: "10:30",
  dailyEnd: "13:30",
  targets: [{ type: "group", id: "g3", name: "Cafeteria Displays" }],
});
const closed = schedule("s-closed", "Night Shutdown", {
  presentationType: "display_control",
  playlistName: "",
  displayAction: { type: "display_power_off" },
  enabled: false,
  priority: 100,
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  dailyStart: "22:00",
  dailyEnd: "06:00",
  targets: ["A", "B", "C", "D", "E"].map((name) => ({
    type: "screen" as const,
    id: name,
    name: `Screen ${name}`,
  })),
});

type Page = {
  items: Schedule[];
  total: number;
  page?: number;
  pageSize?: number;
};

function mockSchedules(
  handler?: (params: Partial<ScheduleListParams>, page: number) => Page,
) {
  return vi
    .spyOn(api, "schedulePage")
    .mockImplementation((params = {}, page = 1) => {
      const result = handler?.(params, page) ?? {
        items: [morning, lunch, closed],
        total: 3,
      };
      return Promise.resolve({
        page,
        pageSize: 100,
        defaultTimezone: "America/Chicago",
        ...result,
      });
    });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<SchedulesPage />} />
          <Route path="/schedules/:id" element={<p>Editing a Schedule</p>} />
          <Route path="/schedules/new" element={<p>New Schedule</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const lastParams = (spy: ReturnType<typeof mockSchedules>) =>
  spy.mock.calls.at(-1)![0] as Partial<ScheduleListParams>;

async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Filters/ }));
}

describe("Schedules library", () => {
  beforeEach(() => {
    auth.role = "administrator";
    stubViewport(false);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("workspace anatomy", () => {
    it("keeps one screen-reader-only H1 and no visible page header or summary card", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      const headings = screen.getAllByRole("heading", { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent("Schedules");
      expect(headings[0]).toHaveClass("sr-only");
      expect(screen.queryByText(/Higher priority wins\./)).toBeNull();
      expect(screen.queryByText("Schedule timeline")).toBeNull();
      expect(screen.queryByText(/loaded of/)).toBeNull();
      expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    });

    it("shows the server total, not the loaded count, and never a zero while loading", async () => {
      mockSchedules(() => ({ items: [morning, lunch], total: 18 }));
      renderPage();

      expect(screen.queryByText(/^\d+ schedules?$/)).toBeNull();
      expect(await screen.findByText("18 schedules")).toBeInTheDocument();
    });

    it("pluralizes a single schedule", async () => {
      mockSchedules(() => ({ items: [morning], total: 1 }));
      renderPage();

      expect(await screen.findByText("1 schedule")).toBeInTheDocument();
    });

    it("links Create schedule for Owners and Administrators", async () => {
      mockSchedules();
      renderPage();

      expect(
        await screen.findByRole("link", { name: "Create schedule" }),
      ).toHaveAttribute("href", "/schedules/new");
    });

    it.each(["editor", "viewer"])("hides Create from %s", async (role) => {
      auth.role = role;
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      expect(screen.queryByRole("link", { name: /^Create/ })).toBeNull();
    });
  });

  describe("search", () => {
    it("waits for a pause, then asks the server once with the settled value", async () => {
      const spy = mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await user.type(screen.getByRole("searchbox"), "lunch");
      expect(spy.mock.calls.some(([params]) => params?.search)).toBe(false);

      await waitFor(() => expect(lastParams(spy).search).toBe("lunch"));
      expect(
        spy.mock.calls.map(([params]) => params?.search).filter(Boolean),
      ).toEqual(["lunch"]);
      // The loaded rows are not filtered in the browser: the server's answer is
      // what renders, even when it does not contain the search text.
      expect(await screen.findByText("Lunch Service")).toBeInTheDocument();
    });

    it("clears the search without touching facets or sort", async () => {
      const spy = mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await user.click(
        screen.getByRole("button", {
          name: "Sort schedules: Recently updated",
        }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Name" }),
      );
      await openFilters(user);
      await user.click(await screen.findByRole("radio", { name: "Enabled" }));
      await user.type(screen.getByRole("searchbox"), "lunch");
      await waitFor(() => expect(lastParams(spy).search).toBe("lunch"));

      await user.click(
        screen.getByRole("button", { name: "Clear search schedules" }),
      );
      await waitFor(() => expect(lastParams(spy).search).toBe(""));
      expect(lastParams(spy)).toMatchObject({ enabled: "true", sort: "name" });
    });
  });

  describe("filters", () => {
    it("opens a Popover with three radio groups on wider screens", async () => {
      mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await openFilters(user);

      for (const [name, options] of [
        ["Status", ["Any", "Enabled", "Disabled"]],
        ["Schedule type", ["Any", "Weekly", "One-time"]],
        ["Presentation", ["Any", "Playlist", "Layout", "Display control"]],
      ] as const) {
        const group = await screen.findByRole("radiogroup", { name });
        expect(
          within(group)
            .getAllByRole("radio")
            .map((radio) => radio.getAttribute("aria-checked")),
        ).toEqual(
          options.map((option) => (option === "Any" ? "true" : "false")),
        );
        for (const option of options)
          expect(
            within(group).getByRole("radio", { name: option }),
          ).toBeInTheDocument();
      }
      expect(
        screen.queryByRole("dialog", { name: "Filters" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    });

    it("sends each facet to the server and restarts at the first page", async () => {
      const spy = mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await openFilters(user);
      await user.click(await screen.findByRole("radio", { name: "Disabled" }));
      await user.click(screen.getByRole("radio", { name: "One-time" }));
      await user.click(screen.getByRole("radio", { name: "Display control" }));

      await waitFor(() =>
        expect(lastParams(spy)).toMatchObject({
          enabled: "false",
          type: "one_time",
          presentationType: "display_control",
          sort: "updated",
        }),
      );
      expect(spy.mock.calls.at(-1)![1]).toBe(1);
    });

    it("announces the active count and shows removable chips with readable labels", async () => {
      mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      expect(
        screen.getByRole("button", { name: "Filters" }),
      ).toBeInTheDocument();
      await openFilters(user);
      await user.click(await screen.findByRole("radio", { name: "Enabled" }));
      await user.click(screen.getByRole("radio", { name: "Weekly" }));
      await user.click(screen.getByRole("button", { name: "Done" }));

      expect(
        await screen.findByRole("button", { name: "Filters, 2 active" }),
      ).toBeInTheDocument();
      const chips = screen.getByRole("group", { name: "Active filters" });
      expect(within(chips).getByText("Status:")).toBeInTheDocument();
      expect(within(chips).getByText("Enabled")).toBeInTheDocument();
      expect(within(chips).getByText("Schedule type:")).toBeInTheDocument();
      expect(within(chips).getByText("Weekly")).toBeInTheDocument();
      expect(within(chips).queryByText("true")).toBeNull();
      expect(within(chips).queryByText("weekly")).toBeNull();
    });

    it("removes one chip without disturbing the others, search, or sort", async () => {
      const spy = mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await user.type(screen.getByRole("searchbox"), "lunch");
      await openFilters(user);
      await user.click(await screen.findByRole("radio", { name: "Enabled" }));
      await user.click(screen.getByRole("radio", { name: "Weekly" }));
      await user.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(lastParams(spy).type).toBe("weekly"));

      await user.click(
        screen.getByRole("button", { name: /Remove .*Schedule type/ }),
      );

      await waitFor(() => expect(lastParams(spy).type).toBe(""));
      expect(lastParams(spy)).toMatchObject({
        search: "lunch",
        enabled: "true",
        sort: "updated",
      });
    });

    it("clears every facet but keeps search and sort", async () => {
      const spy = mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await user.click(
        screen.getByRole("button", {
          name: "Sort schedules: Recently updated",
        }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Highest priority" }),
      );
      await user.type(screen.getByRole("searchbox"), "lunch");
      await openFilters(user);
      await user.click(await screen.findByRole("radio", { name: "Enabled" }));
      await user.click(screen.getByRole("radio", { name: "Layout" }));
      await user.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() =>
        expect(lastParams(spy).presentationType).toBe("layout"),
      );

      await user.click(screen.getByRole("button", { name: "Clear filters" }));

      await waitFor(() =>
        expect(lastParams(spy)).toMatchObject({
          search: "lunch",
          enabled: "",
          type: "",
          presentationType: "",
          sort: "priority",
        }),
      );
    });

    it("resets facets from the Filters surface", async () => {
      const spy = mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await openFilters(user);
      expect(
        screen.getByRole("button", { name: "Reset filters" }),
      ).toBeDisabled();
      await user.click(await screen.findByRole("radio", { name: "Disabled" }));
      await user.click(screen.getByRole("button", { name: "Reset filters" }));

      await waitFor(() => expect(lastParams(spy).enabled).toBe(""));
    });

    it("renders the Drawer instead of a Popover on phones", async () => {
      stubViewport(true);
      mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await openFilters(user);

      const dialog = await screen.findByRole("dialog", { name: "Filters" });
      expect(
        within(dialog).getByText("Narrow the schedules shown in this list."),
      ).toBeInTheDocument();
      // One form, one set of radios: no hidden Popover copy is mounted.
      expect(screen.getAllByRole("radiogroup")).toHaveLength(3);
      await user.click(within(dialog).getByRole("radio", { name: "Enabled" }));
      await user.click(within(dialog).getByRole("button", { name: "Done" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
  });

  describe("sort", () => {
    it("defaults to recently updated, asked of the server", async () => {
      const spy = mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      expect(spy.mock.calls[0]![0]).toMatchObject({ sort: "updated" });
      expect(
        screen.getByRole("button", {
          name: "Sort schedules: Recently updated",
        }),
      ).toBeInTheDocument();
    });

    it("lists the three orders as radios with the current one checked", async () => {
      mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await user.click(
        screen.getByRole("button", {
          name: "Sort schedules: Recently updated",
        }),
      );
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByText("Sort by")).toBeInTheDocument();
      expect(
        within(menu)
          .getAllByRole("menuitemradio")
          .map((item) => [item.textContent, item.getAttribute("aria-checked")]),
      ).toEqual([
        ["Recently updated", "true"],
        ["Name", "false"],
        ["Highest priority", "false"],
      ]);
    });

    it.each([
      ["Name", "name"],
      ["Highest priority", "priority"],
    ])(
      "asks the server for %s order and keeps the server's row order",
      async (label, sort) => {
        const spy = mockSchedules((params) => ({
          items:
            params.sort === "updated"
              ? [morning, lunch, closed]
              : [closed, lunch, morning],
          total: 3,
        }));
        renderPage();
        const user = userEvent.setup();
        await screen.findByText("Morning Broadcast");

        await user.click(
          screen.getByRole("button", {
            name: "Sort schedules: Recently updated",
          }),
        );
        await user.click(
          await screen.findByRole("menuitemradio", { name: label }),
        );

        await waitFor(() => expect(lastParams(spy).sort).toBe(sort));
        expect(spy.mock.calls.at(-1)![1]).toBe(1);
        await waitFor(() =>
          expect(
            screen
              .getAllByRole("link", {
                name: /Morning Broadcast|Lunch Service|Night Shutdown/,
              })
              .map((link) => link.textContent),
          ).toEqual(["Night Shutdown", "Lunch Service", "Morning Broadcast"]),
        );
        expect(
          screen.getByRole("button", { name: `Sort schedules: ${label}` }),
        ).toBeInTheDocument();
      },
    );
  });

  describe("table", () => {
    it("uses real table semantics with named column headers", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      const table = screen.getByRole("table");
      // One representation at a time: no phone list alongside the table.
      expect(screen.queryByRole("list")).toBeNull();
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((header) => header.textContent?.trim()),
      ).toEqual([
        "Schedule",
        "Status",
        "When",
        "Presentation",
        "Targets",
        "Priority",
        "Updated",
        "Actions",
      ]);
      expect(within(table).getAllByRole("row")).toHaveLength(4);
    });

    it("links the name, not the row, and shows the description", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      const link = screen.getByRole("link", { name: "Morning Broadcast" });
      expect(link).toHaveAttribute("href", "/schedules/s-morning");
      expect(link.closest("tr")).not.toHaveAttribute("tabindex");
      expect(
        screen.getByText("Announcements before first period."),
      ).toBeInTheDocument();
    });

    it("shows status in text and keeps a disabled row fully readable", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      const row = screen
        .getByRole("link", { name: "Night Shutdown" })
        .closest("tr")!;
      expect(within(row).getByText("Disabled")).toBeInTheDocument();
      expect(row.className).not.toMatch(/opacity/);
      for (const cell of within(row).getAllByRole("cell"))
        expect(cell.className).not.toMatch(/opacity/);
      expect(
        within(
          screen
            .getByRole("link", { name: "Morning Broadcast" })
            .closest("tr")!,
        ).getByText("Enabled"),
      ).toBeInTheDocument();
    });

    it("reads each schedule at a glance: when, what, where, and precedence", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");
      const text = (row: HTMLElement) =>
        row.textContent?.replace(/\s/g, " ") ?? "";

      const morningRow = screen
        .getByRole("link", { name: "Morning Broadcast" })
        .closest("tr")!;
      expect(text(morningRow)).toContain("Mon–Fri · 7:15 – 8:15 AM");
      expect(text(morningRow)).toContain("America/Chicago");
      expect(text(morningRow)).toContain("Morning Announcements");
      expect(text(morningRow)).toContain("Libraries, Front Office");

      const lunchRow = screen
        .getByRole("link", { name: "Lunch Service" })
        .closest("tr")!;
      expect(text(lunchRow)).toContain("Menu board");
      expect(text(lunchRow)).toContain("Cafeteria Displays");

      const closedRow = screen
        .getByRole("link", { name: "Night Shutdown" })
        .closest("tr")!;
      expect(text(closedRow)).toContain(
        "Every day · 10:00 PM – 6:00 AM next day",
      );
      // A localized sentence, never the raw action type.
      expect(text(closedRow)).toContain("Power off display");
      expect(text(closedRow)).not.toContain("display_power_off");
    });

    it("shows priority as its exact number, not a badge or preset name", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      const rows = screen.getAllByRole("row").slice(1);
      const priorities = rows.map(
        (row) => within(row).getAllByRole("cell")[5]!.textContent,
      );
      expect(priorities).toEqual(["40", "50", "100"]);
      expect(screen.queryByText("Important")).toBeNull();
      expect(screen.queryByText(/Custom/)).toBeNull();
      expect(
        within(screen.getAllByRole("cell")[5]!).queryByText("40")?.className ??
          "",
      ).not.toMatch(/rounded-4xl/);
    });

    it("explains priority on keyboard focus without claiming it is the only rule", async () => {
      mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      const help = screen.getByRole("button", { name: "About priority" });
      await user.tab();
      help.focus();
      expect(
        await screen.findByText(
          "Higher priority wins when eligible schedules overlap.",
        ),
      ).toBeInTheDocument();
    });

    it("collapses many targets and keeps every name reachable", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      const summary = screen.getByText("Screen A, Screen B +3");
      expect(summary).toHaveAttribute(
        "aria-label",
        "All targets: Screen A, Screen B, Screen C, Screen D, Screen E",
      );
      expect(summary).toHaveAttribute("tabindex", "0");
      summary.focus();
      expect(
        await screen.findByText(
          "Screen A, Screen B, Screen C, Screen D, Screen E",
        ),
      ).toBeInTheDocument();
    });

    it("shows the updated time as relative text", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      expect(screen.getAllByText("12 min. ago").length).toBeGreaterThan(0);
    });
  });

  describe("row actions", () => {
    it("offers Edit and a destructive Delete to managers, named for the schedule", async () => {
      mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await user.click(
        screen.getByRole("button", { name: "Actions for Morning Broadcast" }),
      );
      const menu = await screen.findByRole("menu", {
        name: "Actions for Morning Broadcast",
      });
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Edit schedule", "Delete schedule"]);
    });

    it("opens the editor from Edit", async () => {
      mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await user.click(
        screen.getByRole("button", { name: "Actions for Lunch Service" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Edit schedule" }),
      );

      expect(await screen.findByText("Editing a Schedule")).toBeInTheDocument();
    });

    it.each(["editor", "viewer"])(
      "gives %s only Open: no Edit and no Delete",
      async (role) => {
        auth.role = role;
        mockSchedules();
        renderPage();
        const user = userEvent.setup();
        await screen.findByText("Morning Broadcast");

        await user.click(
          screen.getByRole("button", { name: "Actions for Morning Broadcast" }),
        );
        const items = await screen.findAllByRole("menuitem");
        expect(items.map((item) => item.textContent)).toEqual([
          "Open schedule",
        ]);
        await user.click(items[0]!);
        expect(
          await screen.findByText("Editing a Schedule"),
        ).toBeInTheDocument();
      },
    );

    it("never adds an inline enable or disable control", async () => {
      mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      expect(screen.queryByRole("switch")).toBeNull();
      await user.click(
        screen.getByRole("button", { name: "Actions for Night Shutdown" }),
      );
      expect(
        screen.queryByRole("menuitem", { name: /enable|disable/i }),
      ).toBeNull();
    });
  });

  describe("delete", () => {
    async function startDelete(
      user: ReturnType<typeof userEvent.setup>,
      name: string,
    ) {
      await user.click(
        screen.getByRole("button", { name: `Actions for ${name}` }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Delete schedule" }),
      );
    }

    it("asks first, naming the schedule, and does nothing on cancel", async () => {
      mockSchedules();
      const remove = vi
        .spyOn(api, "deleteSchedule")
        .mockResolvedValue(undefined);
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await startDelete(user, "Morning Broadcast");
      const dialog = await screen.findByRole("alertdialog");
      expect(
        within(dialog).getByText("Delete Morning Broadcast?"),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(remove).not.toHaveBeenCalled();
    });

    it("deletes with the CSRF token, announces success, and invalidates Schedule queries", async () => {
      const spy = mockSchedules();
      const remove = vi
        .spyOn(api, "deleteSchedule")
        .mockResolvedValue(undefined);
      const add = vi.spyOn(toast, "add");
      const { client } = renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");
      const before = spy.mock.calls.length;

      await startDelete(user, "Lunch Service");
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Delete",
        }),
      );

      await waitFor(() =>
        expect(remove).toHaveBeenCalledWith("s-lunch", "csrf-token"),
      );
      await waitFor(() =>
        expect(add).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Schedule deleted.",
            type: "success",
          }),
        ),
      );
      // The invalidation makes the open list refetch.
      await waitFor(() =>
        expect(spy.mock.calls.length).toBeGreaterThan(before),
      );
      expect(
        client.getQueryState(
          scheduleKeys.pages({
            search: "",
            enabled: "",
            type: "",
            presentationType: "",
            sort: "updated",
          }),
        ),
      ).toBeDefined();
    });

    it("surfaces a rejected delete without touching the list", async () => {
      mockSchedules();
      vi.spyOn(api, "deleteSchedule").mockRejectedValue(
        new ApiError("Forbidden.", 403, "forbidden"),
      );
      const add = vi.spyOn(toast, "add");
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await startDelete(user, "Morning Broadcast");
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Delete",
        }),
      );

      await waitFor(() =>
        expect(add).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Could not delete the schedule.",
            type: "error",
          }),
        ),
      );
      expect(screen.getByText("Morning Broadcast")).toBeInTheDocument();
    });
  });

  describe("compact layout", () => {
    beforeEach(() => stubViewport(true));

    it("renders a native list and mounts no table", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      expect(screen.queryByRole("table")).toBeNull();
      const list = screen.getByRole("list");
      expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    });

    it("reads name, status, presentation, timing, targets, and priority in order", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      const item = screen
        .getByRole("link", { name: "Morning Broadcast" })
        .closest("li")!;
      const text = item.textContent.replace(/\s/g, " ");
      const order = [
        "Morning Broadcast",
        "Enabled",
        "Morning Announcements",
        "Mon–Fri · 7:15 – 8:15 AM",
        "Libraries, Front Office",
        "Priority 40",
      ].map((part) => text.indexOf(part));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("keeps the name link and the action menu as separate controls", async () => {
      mockSchedules();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      const item = screen
        .getByRole("link", { name: "Morning Broadcast" })
        .closest("li")!;
      expect(item).not.toHaveAttribute("tabindex");
      expect(within(item).getAllByRole("link")).toHaveLength(1);
      await user.click(
        within(item).getByRole("button", {
          name: "Actions for Morning Broadcast",
        }),
      );
      expect(
        await screen.findByRole("menuitem", { name: "Edit schedule" }),
      ).toBeInTheDocument();
    });

    it("shortens Create but keeps its full accessible name", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      const create = screen.getByRole("link", { name: "Create schedule" });
      expect(create).toHaveTextContent("Create");
      expect(create).not.toHaveTextContent("Create schedule");
    });

    it("puts Sort beside Filters", async () => {
      mockSchedules();
      renderPage();
      await screen.findByText("Morning Broadcast");

      expect(
        screen.getByRole("button", {
          name: "Sort schedules: Recently updated",
        }),
      ).toHaveTextContent("Sort");
    });
  });

  describe("states", () => {
    it("previews a table while loading", async () => {
      vi.spyOn(api, "schedulePage").mockReturnValue(
        new Promise(() => undefined),
      );
      renderPage();

      const status = await screen.findByRole("status", {
        name: "Loading schedules",
      });
      expect(status.querySelector("table")).not.toBeNull();
      expect(
        within(status).getAllByRole("columnheader").length,
      ).toBeGreaterThanOrEqual(4);
      expect(screen.queryByText("No schedules yet")).toBeNull();
    });

    it("previews a list while loading on phones", async () => {
      stubViewport(true);
      vi.spyOn(api, "schedulePage").mockReturnValue(
        new Promise(() => undefined),
      );
      renderPage();

      const status = await screen.findByRole("status", {
        name: "Loading schedules",
      });
      expect(status.querySelector("table")).toBeNull();
      expect(screen.queryByText("No schedules yet")).toBeNull();
    });

    it("shows a retryable error, not the empty state, when the first load fails", async () => {
      const spy = vi
        .spyOn(api, "schedulePage")
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({
          items: [morning],
          total: 1,
          page: 1,
          pageSize: 100,
          defaultTimezone: "America/Chicago",
        });
      renderPage();
      const user = userEvent.setup();

      expect(
        await screen.findByText("Could not load schedules."),
      ).toBeInTheDocument();
      expect(screen.queryByText("No schedules yet")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Retry" }));

      expect(await screen.findByText("Morning Broadcast")).toBeInTheDocument();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Could not load schedules.")).toBeNull();
    });

    it("shows the empty library with Create for managers", async () => {
      mockSchedules(() => ({ items: [], total: 0 }));
      renderPage();

      expect(await screen.findByText("No schedules yet")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Schedules let content or display actions run on selected screens at specific times.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getAllByRole("link", { name: "Create schedule" }),
      ).toHaveLength(2);
    });

    it("offers viewers no Create in the empty library", async () => {
      auth.role = "viewer";
      mockSchedules(() => ({ items: [], total: 0 }));
      renderPage();

      expect(await screen.findByText("No schedules yet")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Create/ })).toBeNull();
    });

    it("tells a failed search from an empty library and keeps sort on reset", async () => {
      const spy = mockSchedules((params) =>
        params.search || params.enabled
          ? { items: [], total: 0 }
          : { items: [morning], total: 1 },
      );
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");

      await user.click(
        screen.getByRole("button", {
          name: "Sort schedules: Recently updated",
        }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Name" }),
      );
      await openFilters(user);
      await user.click(await screen.findByRole("radio", { name: "Disabled" }));
      await user.click(screen.getByRole("button", { name: "Done" }));
      await user.type(screen.getByRole("searchbox"), "zzz");
      await waitFor(() => expect(lastParams(spy).search).toBe("zzz"));

      expect(await screen.findByText("No schedules match")).toBeInTheDocument();
      expect(
        screen.getByText("Try another search or change your filters."),
      ).toBeInTheDocument();
      expect(screen.queryByText("No schedules yet")).toBeNull();
      // Create is not the answer to a failed search.
      expect(
        screen.getAllByRole("link", { name: "Create schedule" }),
      ).toHaveLength(1);

      await user.click(
        screen.getByRole("button", { name: "Clear search and filters" }),
      );

      expect(await screen.findByText("Morning Broadcast")).toBeInTheDocument();
      expect(lastParams(spy)).toMatchObject({
        search: "",
        enabled: "",
        type: "",
        presentationType: "",
        sort: "name",
      });
      expect(screen.getByRole("searchbox")).toHaveValue("");
    });

    it("loads more pages in server order and announces the fetch", async () => {
      const first = [morning, lunch];
      const second = [closed];
      const spy = mockSchedules((_params, page) => ({
        items: page === 1 ? first : second,
        total: 3,
        pageSize: 2,
      }));
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Morning Broadcast");
      expect(screen.queryByText("Night Shutdown")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Load more" }));

      await screen.findByText("Night Shutdown");
      expect(spy.mock.calls.map((call) => call[1])).toEqual([1, 2]);
      expect(
        screen
          .getAllByRole("link", {
            name: /Morning Broadcast|Lunch Service|Night Shutdown/,
          })
          .map((link) => link.textContent),
      ).toEqual(["Morning Broadcast", "Lunch Service", "Night Shutdown"]);
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      expect(screen.queryByText(/loaded of/)).toBeNull();
    });

    it("keeps already-loaded rows when a background refetch fails, with the error beside them", async () => {
      const spy = mockSchedules();
      const { client } = renderPage();
      await screen.findByText("Morning Broadcast");

      spy.mockRejectedValue(new Error("offline"));
      await client.invalidateQueries({ queryKey: scheduleKeys.all });

      expect(
        await screen.findByText("Could not load schedules."),
      ).toBeInTheDocument();
      expect(screen.getByText("Morning Broadcast")).toBeInTheDocument();
      expect(screen.queryByText("No schedules yet")).toBeNull();
    });
  });
});
