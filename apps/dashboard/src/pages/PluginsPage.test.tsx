// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogPlugin } from "../plugins/catalogFixtures";
import { CountdownBarEditorPage } from "./CountdownBarsPage";
import { BrandBugEditorPage, BrandBugsPage } from "./BrandBugsPage";
import { NoiseMeterEditorPage, NoiseMetersPage } from "./NoiseMetersPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      authenticated: true,
      csrfToken: "csrf",
      user: { id: "owner", name: "Owner", role: "owner" },
    },
  }),
}));

function renderRoute(element: ReactNode, path = "/plugins") {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {/* Mirrors App.tsx, where "new" is a static route rather than an :id. */}
          <Route path="/plugins/countdown-bar/new" element={element} />
          <Route path="/plugins/countdown-bar/:id" element={element} />
          <Route path="/plugins/brand-bug/new" element={element} />
          <Route path="/plugins/brand-bug/:id" element={element} />
          <Route path="/plugins/noise-meter/new" element={element} />
          <Route path="/plugins/noise-meter/:id" element={element} />
          <Route path="*" element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Rhea Select hides its native control, so pick the way a person does. */
async function chooseOption(selectLabel: string, optionLabel: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: selectLabel }));
  await user.click(await screen.findByRole("option", { name: optionLabel }));
}

/** Same, for a select whose options arrive with a query rather than statically. */
async function chooseLoadedOption(
  selectLabel: string | RegExp,
  optionLabel: string,
) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: selectLabel }));
  await user.click(await screen.findByRole("option", { name: optionLabel }));
}

async function chooseDate(label: string | RegExp, day: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: label }));
  await user.click(await screen.findByRole("button", { name: day }));
}

function currentMonthDay(day: 1 | 10) {
  const month = new Date().toLocaleString("en-US", { month: "long" });
  const year = new Date().getFullYear();
  return new RegExp(
    month + " " + (day === 1 ? "1st" : "10th") + ", " + year + "$",
  );
}

function pressedDays() {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].filter(
    (day) =>
      screen.getByRole("button", { name: day }).getAttribute("aria-pressed") ===
      "true",
  );
}

const storedInstance = {
  id: "bar-1",
  name: "Lunch",
  message: "Lunch ends in",
  scheduleType: "weekly",
  targetTime: "12:00",
  daysOfWeek: [1, 3],
  oneTimeAt: null,
  timezone: "America/New_York",
  leadTimeSeconds: 900,
  completionText: "",
  showConfetti: true,
  displayMode: "overlay",
  progressFill: "drain",
  heightPx: 72,
  contentPadding: 2,
  textScale: 125,
  urgencyEnabled: true,
  startingSoonSeconds: 300,
  urgentSeconds: 60,
  pulseSeconds: 10,
  enabled: true,
  priority: 0,
  targetScope: "all",
  targetIds: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

const storedBrandBug = {
  id: "bug-1",
  name: "Sponsor logo",
  corner: "bottom_right",
  imageAssetId: "asset-1",
  text: "Presented by Example",
  widthPercent: 14,
  textSizePercent: 3,
  opacityPercent: 80,
  marginPercent: 4,
  textColor: "#ffffff",
  backgroundStyle: "scrim",
  startsAt: null,
  endsAt: null,
  enabled: true,
  priority: 10,
  targetScope: "all",
  targetIds: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

const storedNoiseMeter = {
  id: "meter-1",
  name: "Cafeteria noise",
  message: "Please lower the volume",
  warningLevel: 55,
  loudLevel: 78,
  sensitivity: 130,
  triggerHoldMs: 1500,
  clearHoldMs: 4500,
  displayMode: "push",
  heightPx: 110,
  historyEnabled: true,
  historyRetentionDays: 14,
  historyActiveHoursOnly: false,
  scheduleEnabled: true,
  scheduleDaysOfWeek: [1, 3, 5],
  scheduleStartTime: "08:30",
  scheduleEndTime: "14:45",
  scheduleTimezone: "America/Chicago",
  enabled: true,
  targetScope: "all",
  targetIds: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

const submitted: Record<string, unknown>[] = [];

beforeEach(() => {
  submitted.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (init?.method && init.method !== "GET") {
        submitted.push(
          JSON.parse(
            typeof init.body === "string" ? init.body : "{}",
          ) as Record<string, unknown>,
        );
        return Promise.resolve(new Response(JSON.stringify({ data: {} })));
      }
      if (path.includes("/instances/bar-1")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: storedInstance })),
        );
      }
      if (path.includes("/brand-bug/instances/bug-1")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: storedBrandBug })),
        );
      }
      if (path.includes("/noise-meter/instances/meter-1")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: storedNoiseMeter })),
        );
      }
      if (path.includes("/noise-meter/instances")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { items: [storedNoiseMeter], total: 1 } }),
          ),
        );
      }
      if (path.includes("/brand-bug/instances")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { items: [storedBrandBug], total: 1 } }),
          ),
        );
      }
      if (path.includes("/assets?")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                items: [{ id: "asset-1", name: "District logo" }],
                total: 1,
              },
            }),
          ),
        );
      }
      if (path.endsWith("/plugins")) {
        // Every plugin these editors belong to is installed.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                items: [
                  "countdown_bar",
                  "emergency_alerts",
                  "forms",
                  "brand_bug",
                  "noise_meter",
                ].map((id) => catalogPlugin({ id })),
                unsupportedInstallations: [],
              },
            }),
          ),
        );
      }
      const data = path.endsWith("/screens")
        ? { items: [{ id: "screen-1", name: "Cafeteria" }], total: 1 }
        : path.includes("screen-groups")
          ? { items: [], total: 0, page: 1, pageSize: 100 }
          : { items: [], total: 0 };
      return Promise.resolve(new Response(JSON.stringify({ data })));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Plugins", () => {
  it("requires a target when a scoped instance is submitted", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() =>
      expect(screen.getByLabelText("Target type")).toBeEnabled(),
    );
    await chooseOption("Target type", "Individual screens");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    expect(
      await screen.findByText("Choose at least one target."),
    ).toBeVisible();
  }, 10_000);

  it("submits the weekdays left selected after a day is toggled off", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    expect(pressedDays()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wed" }));
    expect(pressedDays()).toEqual(["Mon", "Tue", "Thu", "Fri"]);
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.daysOfWeek).toEqual([1, 2, 4, 5]);
  }, 10_000);

  it("shows and preserves the days stored on an existing instance", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/bar-1");
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Lunch"),
    );
    expect(pressedDays()).toEqual(["Mon", "Wed"]);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.daysOfWeek).toEqual([1, 3]);
    expect(submitted[0]?.progressFill).toBe("drain");
    expect(submitted[0]?.contentPadding).toBe(2);
    expect(submitted[0]?.textScale).toBe(125);
    expect(submitted[0]?.showConfetti).toBe(true);
    expect(submitted[0]?.urgencyEnabled).toBe(true);
    expect(submitted[0]?.startingSoonSeconds).toBe(300);
  }, 10_000);

  it("submits the checkbox groups it renders", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
    await chooseOption("Target type", "Individual screens");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Cafeteria" }));
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.enabled).toBe(false);
    expect(submitted[0]?.targetIds).toEqual(["screen-1"]);
  }, 10_000);

  it("counts the chosen targets and explains an empty scope", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    await chooseOption("Target type", "Individual screens");
    expect(await screen.findByText("0 of 1 selected")).toBeVisible();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Cafeteria" }));
    expect(screen.getByText("1 of 1 selected")).toBeVisible();
    // No Display Groups exist in this fixture, so the list must say so rather than
    // render an empty box.
    await chooseOption("Target type", "Display Groups");
    expect(
      await screen.findByText("No Display Groups exist yet."),
    ).toBeVisible();
    expect(screen.getByText("0 of 0 selected")).toBeVisible();
  }, 10_000);

  it("submits the background countdown choice and preserves a stored one", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    await chooseOption("Background countdown", "Drain right to left");
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.progressFill).toBe("drain");
  }, 10_000);

  it("submits the optional confetti celebration", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Show confetti when the countdown reaches zero",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.showConfetti).toBe(true);
  }, 10_000);

  it("configures ordered countdown urgency stages", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    expect(screen.queryByLabelText(/Starting soon/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Enable countdown urgency stages",
      }),
    );
    fireEvent.change(screen.getByLabelText(/Starting soon/), {
      target: { value: "8" },
    });
    fireEvent.change(screen.getByLabelText(/Urgent \(red\)/), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByLabelText(/Pulse and enlarge/), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      urgencyEnabled: true,
      startingSoonSeconds: 480,
      urgentSeconds: 90,
      pulseSeconds: 15,
    });
  }, 10_000);

  it("keeps untouched urgency defaults linked to the total lead time", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Enable countdown urgency stages",
      }),
    );
    fireEvent.change(screen.getByLabelText("Appear this many minutes before"), {
      target: { value: "30" },
    });
    expect(screen.getByLabelText(/Starting soon/)).toHaveValue(10);
    expect(screen.getByLabelText(/Urgent \(red\)/)).toHaveValue(120);
    expect(screen.getByLabelText(/Pulse and enlarge/)).toHaveValue(20);

    // Once one stage is customized, that stage stays fixed while the still-
    // linked defaults continue to follow the total window.
    fireEvent.change(screen.getByLabelText(/Urgent \(red\)/), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByLabelText("Appear this many minutes before"), {
      target: { value: "45" },
    });
    expect(screen.getByLabelText(/Starting soon/)).toHaveValue(15);
    expect(screen.getByLabelText(/Urgent \(red\)/)).toHaveValue(90);
    expect(screen.getByLabelText(/Pulse and enlarge/)).toHaveValue(30);
  }, 10_000);

  it("submits custom padding and text size", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    fireEvent.change(screen.getByLabelText("Horizontal padding (%)"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Text size (%)"), {
      target: { value: "180" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.contentPadding).toBe(0);
    expect(submitted[0]?.textScale).toBe(180);
  }, 10_000);

  it("keeps the schedule and mode selections across an unrelated edit", async () => {
    renderRoute(<CountdownBarEditorPage />, "/plugins/countdown-bar/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    await chooseOption("Mode", "Push and shrink current content");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    // A weekday toggle re-renders the form; a select whose value was dropped
    // here would silently fall back to its first option.
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    expect(screen.getByLabelText("Target time")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.scheduleType).toBe("weekly");
    expect(submitted[0]?.displayMode).toBe("push");
  }, 10_000);
});

describe("Brand Bug", () => {
  it("summarizes what a configured mark puts on screen", async () => {
    renderRoute(<BrandBugsPage />, "/plugins/brand-bug");
    expect(
      await screen.findByRole("heading", { name: "Sponsor logo" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Bottom right · logo · \u201cPresented by Example\u201d · 80% opacity",
      ),
    ).toBeVisible();
  });

  it("requires a logo or text before it can be created", async () => {
    renderRoute(<BrandBugEditorPage />, "/plugins/brand-bug/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Empty mark" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    expect(
      await screen.findByText("Choose a logo image, enter text, or both."),
    ).toBeVisible();
    expect(submitted).toHaveLength(0);
  }, 10_000);

  it("submits a chosen logo, corner, and campaign window", async () => {
    renderRoute(<BrandBugEditorPage />, "/plugins/brand-bug/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Sponsor logo" },
    });
    await chooseLoadedOption(/^Logo image/, "District logo");
    await chooseOption("Corner", "Bottom left");
    await chooseDate(/^Show from/, currentMonthDay(1));
    fireEvent.change(screen.getByLabelText("Start time"), {
      target: { value: "08:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      name: "Sponsor logo",
      corner: "bottom_left",
      imageAssetId: "asset-1",
      text: "",
      endsAt: null,
    });
    expect(String(submitted[0]?.startsAt)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  }, 10_000);

  it("rejects a window that ends before it starts", async () => {
    renderRoute(<BrandBugEditorPage />, "/plugins/brand-bug/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Campaign badge" },
    });
    fireEvent.change(screen.getByPlaceholderText("Presented by Example"), {
      target: { value: "Vote Tuesday" },
    });
    await chooseDate(/^Show from/, currentMonthDay(10));
    fireEvent.change(screen.getByLabelText("Start time"), {
      target: { value: "08:00" },
    });
    await chooseDate(/^Show until/, currentMonthDay(1));
    fireEvent.change(screen.getByLabelText("End time"), {
      target: { value: "08:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    expect(
      await screen.findByText("The end must be after the start."),
    ).toBeVisible();
    expect(submitted).toHaveLength(0);
  }, 10_000);

  it("keeps every select across an unrelated edit and preserves the stored mark", async () => {
    renderRoute(<BrandBugEditorPage />, "/plugins/brand-bug/bug-1");
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Sponsor logo"),
    );
    // A select whose value react-hook-form dropped here would silently revert
    // to its first option on the next render.
    fireEvent.change(screen.getByLabelText("Opacity (%)"), {
      target: { value: "55" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      corner: "bottom_right",
      imageAssetId: "asset-1",
      backgroundStyle: "scrim",
      targetScope: "all",
      opacityPercent: 55,
      priority: 10,
    });
  }, 10_000);
});

describe("Noise Meter", () => {
  it("says where the plugin runs and what leaves the player", async () => {
    renderRoute(<NoiseMetersPage />, "/plugins/noise-meter");
    // Operators have to be able to see that this is Linux-only and that no
    // audio is sent anywhere without reading the docs.
    expect(
      await screen.findByText(/Linux Player only/, { exact: false }),
    ).toBeVisible();
    expect(
      screen.getByText(/never sent to Tilecast/, { exact: false }),
    ).toBeVisible();
    expect(await screen.findByText(/Shows above 78/)).toBeVisible();
  });

  it("states that the level is relative rather than a decibel measurement", async () => {
    renderRoute(<NoiseMeterEditorPage />, "/plugins/noise-meter/new");
    expect(
      await screen.findByText(
        "Noise levels are relative to this player's microphone and are not calibrated decibel measurements.",
      ),
    ).toBeVisible();
  }, 10_000);

  it("shows the stored holds in seconds and submits them as milliseconds", async () => {
    renderRoute(<NoiseMeterEditorPage />, "/plugins/noise-meter/meter-1");
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Cafeteria noise"),
    );
    expect(screen.getByLabelText(/Show after \(seconds\)/)).toHaveValue(1.5);
    expect(
      screen.getByLabelText(/Hide after normal for \(seconds\)/),
    ).toHaveValue(4.5);
    fireEvent.change(
      screen.getByLabelText(/Hide after normal for \(seconds\)/),
      { target: { value: "6" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      warningLevel: 55,
      loudLevel: 78,
      sensitivity: 130,
      triggerHoldMs: 1500,
      clearHoldMs: 6000,
      // A select react-hook-form dropped would silently revert to "overlay".
      displayMode: "push",
      heightPx: 110,
      // History settings round-trip with the rest of the instance.
      historyEnabled: true,
      historyRetentionDays: 14,
      historyActiveHoursOnly: false,
      // The display window round-trips, including its days and timezone.
      scheduleEnabled: true,
      scheduleDaysOfWeek: [1, 3, 5],
      scheduleStartTime: "08:30",
      scheduleEndTime: "14:45",
      scheduleTimezone: "America/Chicago",
      targetScope: "all",
    });
  }, 10_000);

  it("states the privacy position on the History settings", async () => {
    renderRoute(<NoiseMeterEditorPage />, "/plugins/noise-meter/new");
    expect(
      await screen.findByText(
        "Saves only relative noise-level measurements. Microphone audio is never recorded or uploaded.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Save noise history" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "Collect only during active hours",
      }),
    ).toBeChecked();
  }, 10_000);

  it("hides the window controls until a window is asked for", async () => {
    renderRoute(<NoiseMeterEditorPage />, "/plugins/noise-meter/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Only show during a set time window",
      }),
    );
    expect(await screen.findByLabelText("From")).toBeVisible();
    expect(screen.getByLabelText(/^Until/)).toHaveValue("15:30");
  }, 10_000);

  it("submits the configured display window", async () => {
    renderRoute(<NoiseMeterEditorPage />, "/plugins/noise-meter/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Only show during a set time window",
      }),
    );
    fireEvent.change(await screen.findByLabelText("From"), {
      target: { value: "09:15" },
    });
    fireEvent.change(screen.getByLabelText(/^Until/), {
      target: { value: "12:45" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wed" }));
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      scheduleEnabled: true,
      scheduleStartTime: "09:15",
      scheduleEndTime: "12:45",
      scheduleDaysOfWeek: [1, 2, 4, 5],
    });
  }, 10_000);

  it("refuses a window that could never open", async () => {
    renderRoute(<NoiseMeterEditorPage />, "/plugins/noise-meter/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Only show during a set time window",
      }),
    );
    // Every day switched off: the bar would never appear again.
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      fireEvent.click(await screen.findByRole("button", { name: day }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    expect(await screen.findByText("Choose at least one day.")).toBeVisible();
    expect(submitted).toHaveLength(0);
  }, 10_000);

  it("refuses a warning level at or above the too loud level", async () => {
    renderRoute(<NoiseMeterEditorPage />, "/plugins/noise-meter/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/Warning level/), {
      target: { value: "85" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    // One threshold for both directions is what makes a bar flap.
    expect(
      await screen.findByText(
        "The warning level must be below the too loud level.",
      ),
    ).toBeVisible();
    expect(submitted).toHaveLength(0);
  }, 10_000);

  it("submits the documented defaults for a new instance", async () => {
    renderRoute(<NoiseMeterEditorPage />, "/plugins/noise-meter/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      name: "Noise Meter",
      message: "Please lower the volume",
      warningLevel: 60,
      loudLevel: 80,
      sensitivity: 100,
      triggerHoldMs: 1000,
      clearHoldMs: 3000,
      displayMode: "overlay",
      heightPx: 96,
      // History is on by default, kept for a week, and confined to active hours.
      historyEnabled: true,
      historyRetentionDays: 7,
      historyActiveHoursOnly: true,
      // No window by default: a too-loud room may raise the bar at any time,
      // and no half-configured bounds are sent.
      scheduleEnabled: false,
      scheduleDaysOfWeek: [],
      scheduleStartTime: null,
      scheduleEndTime: null,
      enabled: true,
      targetScope: "all",
      targetIds: [],
    });
  }, 10_000);
});
