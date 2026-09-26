// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseOption,
  renderPluginRoute,
  stubStudioApi,
} from "@tilecast/studio/testing";
import { CountdownBarEditorPage } from "./CountdownBarsPage";

function renderEditor(path: string) {
  return renderPluginRoute(<CountdownBarEditorPage />, {
    path,
    // Mirrors the plugin's routes, where "new" is static rather than an :id.
    patterns: ["/plugins/countdown-bar/new", "/plugins/countdown-bar/:id"],
  });
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

let submitted: Record<string, unknown>[] = [];

beforeEach(() => {
  ({ submitted } = stubStudioApi({
    installed: ["countdown_bar"],
    respond: (path) =>
      path.endsWith("/plugins/countdown-bar/instances/bar-1")
        ? storedInstance
        : undefined,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Countdown Bar editor", () => {
  it("requires a target when a scoped instance is submitted", async () => {
    renderEditor("/plugins/countdown-bar/new");
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
    renderEditor("/plugins/countdown-bar/new");
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
    renderEditor("/plugins/countdown-bar/bar-1");
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
    renderEditor("/plugins/countdown-bar/new");
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
    renderEditor("/plugins/countdown-bar/new");
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
    renderEditor("/plugins/countdown-bar/new");
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
    renderEditor("/plugins/countdown-bar/new");
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
    renderEditor("/plugins/countdown-bar/new");
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
    renderEditor("/plugins/countdown-bar/new");
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
    renderEditor("/plugins/countdown-bar/new");
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
    renderEditor("/plugins/countdown-bar/new");
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
