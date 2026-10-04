// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginT } from "@tilecast/studio";
import { i18n, renderPluginRoute } from "@tilecast/studio/testing";
import { api } from "./api";
import type { NWSAlertRule } from "./types";
import en from "./locales/en.json";
import {
  emergencyDisplayLabel,
  emergencyPlaylistLabel,
  EmergencyAlertsPage,
} from "./EmergencyAlertsPage";

// Plugin namespaces register dynamically and are deliberately absent from
// Studio's central Namespace union, so type the fixed translator with the
// plugin's own English resources instead of widening the central type.
const getPluginT = i18n.getFixedT.bind(i18n) as unknown as (
  lng: string,
  ns: string,
) => PluginT<typeof en>;
const t = getPluginT("en", "plugin.emergency_alerts");

let role = "owner";

beforeEach(() => {
  role = "owner";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Emergency Alerts plugin", () => {
  it("configures NWS automation under Plugins and exposes poll health", async () => {
    vi.spyOn(api, "nwsAlertSettings").mockResolvedValue({
      monitor: {
        enabled: true,
        areas: ["OH"],
        zones: [],
        pollIntervalSeconds: 120,
        lastPolledAt: "2026-07-28T12:00:00Z",
        lastSuccessAt: "2026-07-28T12:00:00Z",
        lastMatchedCount: 1,
        updatedAt: "2026-07-28T12:00:00Z",
      },
      rules: [],
      activeAlerts: [],
    });
    vi.spyOn(api, "screens").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "screenGroups").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "playlists").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "nwsZones").mockResolvedValue({ items: [] });
    renderPluginRoute(<EmergencyAlertsPage />, {
      path: "/plugins/emergency-alerts",
      role,
    });

    expect(
      await screen.findByRole("heading", {
        name: "Automated weather alerts",
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Optional: manage custom playlists" })
        .getAttribute("href"),
    ).toBe("/playlists");
    expect(
      screen
        .getByRole("link", { name: "Start a Takeover now" })
        .getAttribute("href"),
    ).toBe("/screens");
    expect(await screen.findByText("Entire Ohio")).toBeTruthy();
    expect(await screen.findByText("Matched rules")).toBeTruthy();
    expect(
      screen.getByText(/best-effort, not a life-safety system/i),
    ).toBeTruthy();
    // It is a plugin page now, so it leads back to the catalog rather than
    // sitting inside the Settings shell.
    expect(
      screen.getByRole("link", { name: /Plugins/ }).getAttribute("href"),
    ).toBe("/plugins");
    expect(
      screen.getByRole("heading", { level: 1, name: "Emergency Alerts" }),
    ).toBeTruthy();
  });

  it("disables NWS monitor controls and management actions when read-only", async () => {
    role = "viewer";
    vi.spyOn(api, "nwsAlertSettings").mockResolvedValue({
      monitor: {
        enabled: true,
        areas: ["OH"],
        zones: ["OHC049"],
        pollIntervalSeconds: 120,
        lastMatchedCount: 0,
        updatedAt: "2026-07-28T12:00:00Z",
      },
      rules: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Tornadoes",
          enabled: true,
          eventNames: ["Tornado Warning"],
          minimumSeverity: "Severe",
          minimumUrgency: "Expected",
          responseMode: "takeover",
          presentationMode: "playlist",
          playlistId: "22222222-2222-4222-8222-222222222222",
          playlistName: "Emergency",
          tickerDisplayMode: "push",
          tickerHeightPx: 96,
          tickerSpeed: "medium",
          maximumDurationMinutes: 360,
          screenIds: [],
          groupIds: [],
          createdAt: "2026-07-28T12:00:00Z",
          updatedAt: "2026-07-28T12:00:00Z",
        },
      ],
      activeAlerts: [],
    });
    vi.spyOn(api, "screens").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "screenGroups").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "playlists").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "nwsZones").mockResolvedValue({
      items: [
        {
          id: "OHC049",
          name: "Franklin",
          state: "OH",
          type: "county",
        },
      ],
    });
    renderPluginRoute(<EmergencyAlertsPage />, {
      path: "/plugins/emergency-alerts",
      role,
    });

    expect(
      (
        await screen.findByRole("switch", { name: "Automated NWS monitoring" })
      ).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByLabelText("State or territory")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("County or forecast zone")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("Poll interval")).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Save NWS monitor" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Check now" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("selects a state and a saved NWS location without entering codes", async () => {
    vi.spyOn(api, "nwsAlertSettings").mockResolvedValue({
      monitor: {
        enabled: true,
        areas: [],
        zones: [],
        pollIntervalSeconds: 120,
        lastMatchedCount: 0,
        updatedAt: "2026-07-28T12:00:00Z",
      },
      rules: [],
      activeAlerts: [],
    });
    vi.spyOn(api, "screens").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "screenGroups").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "playlists").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "nwsZones").mockResolvedValue({
      items: [
        {
          id: "OHC049",
          name: "Franklin",
          state: "OH",
          type: "county",
        },
      ],
    });
    const update = vi.spyOn(api, "updateNWSAlertMonitor").mockResolvedValue({
      enabled: true,
      areas: ["OH"],
      zones: ["OHC049"],
      pollIntervalSeconds: 120,
      lastMatchedCount: 0,
      updatedAt: "2026-07-28T12:00:00Z",
    });
    renderPluginRoute(<EmergencyAlertsPage />, {
      path: "/plugins/emergency-alerts",
      role,
    });
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText("State or territory"),
      "OH",
    );
    await user.click(
      screen.getByRole("button", { name: "Monitor entire state" }),
    );
    await user.selectOptions(
      await screen.findByLabelText("County or forecast zone"),
      "OHC049",
    );
    await user.click(screen.getByRole("button", { name: "Add location" }));
    await user.click(screen.getByRole("button", { name: "Save NWS monitor" }));

    expect(update).toHaveBeenCalledWith(
      {
        enabled: true,
        areas: ["OH"],
        zones: ["OHC049"],
        pollIntervalSeconds: 120,
      },
      "csrf",
    );
  });

  it("preserves comma-separated event text until rule submission", async () => {
    vi.spyOn(api, "nwsAlertSettings").mockResolvedValue({
      monitor: {
        enabled: false,
        areas: [],
        zones: [],
        pollIntervalSeconds: 120,
        lastMatchedCount: 0,
        updatedAt: "2026-07-28T12:00:00Z",
      },
      rules: [],
      activeAlerts: [],
    });
    vi.spyOn(api, "screens").mockResolvedValue({
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Lobby",
        },
      ],
      total: 1,
    });
    vi.spyOn(api, "screenGroups").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "playlists").mockResolvedValue({
      items: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Weather alert",
          itemCount: 1,
        },
      ],
      total: 1,
    });
    const create = vi.spyOn(api, "createNWSAlertRule").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Warnings",
      enabled: true,
      eventNames: ["Tornado Warning", "Flash Flood Warning"],
      minimumSeverity: "Severe",
      minimumUrgency: "Expected",
      responseMode: "takeover",
      presentationMode: "builtin",
      tickerDisplayMode: "push",
      tickerHeightPx: 96,
      tickerSpeed: "medium",
      maximumDurationMinutes: 360,
      screenIds: ["11111111-1111-4111-8111-111111111111"],
      groupIds: [],
      createdAt: "2026-07-28T12:00:00Z",
      updatedAt: "2026-07-28T12:00:00Z",
    });
    renderPluginRoute(<EmergencyAlertsPage />, {
      path: "/plugins/emergency-alerts",
      role,
    });
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Weather event rules" });
    await user.type(screen.getByLabelText("Rule name"), "Warnings");
    const eventNames = screen.getByLabelText("NWS event names");
    await user.clear(eventNames);
    await user.type(eventNames, "Tornado Warning, Flash Flood Warning");
    await user.click(await screen.findByRole("checkbox", { name: "Lobby" }));
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventNames: ["Tornado Warning", "Flash Flood Warning"],
        responseMode: "takeover",
        presentationMode: "builtin",
        playlistId: undefined,
      }),
      "csrf",
    );

    // Choosing the ticker reveals the bar's own shape, and saves as a response
    // mode rather than as a third kind of presentation. A saved rule empties the
    // editor, so the second rule is entered from scratch.
    await user.type(screen.getByLabelText("Rule name"), "Ticker warnings");
    await user.click(await screen.findByRole("checkbox", { name: "Lobby" }));
    await user.selectOptions(
      screen.getByLabelText(/Emergency display/),
      "ticker",
    );
    await user.selectOptions(screen.getByLabelText("Ticker placement"), "push");
    await user.selectOptions(screen.getByLabelText("Ticker speed"), "fast");
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseMode: "ticker",
        presentationMode: "builtin",
        tickerDisplayMode: "push",
        tickerHeightPx: 96,
        tickerSpeed: "fast",
        playlistId: undefined,
      }),
      "csrf",
    );
  });

  it("names what a rule will do without opening its editor", () => {
    expect(
      emergencyDisplayLabel(
        {
          responseMode: "ticker",
          presentationMode: "builtin",
        },
        t,
      ),
    ).toBe("Tilecast live NWS ticker bar");
    expect(
      emergencyDisplayLabel(
        {
          responseMode: "takeover",
          presentationMode: "playlist",
          playlistName: "Closure",
        },
        t,
      ),
    ).toBe("Closure");
  });

  it("makes playlist readiness visible before a weather rule is saved", () => {
    expect(emergencyPlaylistLabel({ name: "Tornado", itemCount: 3 }, t)).toBe(
      "Tornado — 3 items",
    );
    expect(
      emergencyPlaylistLabel({ name: "Closure draft", itemCount: 0 }, t),
    ).toBe("Closure draft — empty, add content first");
  });
});

describe("Emergency Alerts unsaved changes", () => {
  function mockSettings(rules: NWSAlertRule[] = [], pollIntervalSeconds = 120) {
    vi.spyOn(api, "nwsAlertSettings").mockResolvedValue({
      monitor: {
        enabled: true,
        areas: ["OH"],
        zones: [],
        pollIntervalSeconds,
        lastPolledAt: "2026-07-28T12:00:00Z",
        lastSuccessAt: "2026-07-28T12:00:00Z",
        lastMatchedCount: 1,
        updatedAt: "2026-07-28T12:00:00Z",
      },
      rules,
      activeAlerts: [],
    });
    vi.spyOn(api, "screens").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "screenGroups").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "playlists").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(api, "nwsZones").mockResolvedValue({ items: [] });
  }

  const tornadoRule: NWSAlertRule = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Tornadoes",
    enabled: true,
    eventNames: ["Tornado Warning"],
    minimumSeverity: "Severe",
    minimumUrgency: "Expected",
    responseMode: "takeover",
    presentationMode: "builtin",
    playlistId: undefined,
    playlistName: "",
    tickerDisplayMode: "push",
    tickerHeightPx: 96,
    tickerSpeed: "medium",
    maximumDurationMinutes: 360,
    screenIds: [],
    groupIds: [],
    createdAt: "2026-07-28T12:00:00Z",
    updatedAt: "2026-07-28T12:00:00Z",
  };

  it("confirms before Cancel discards a dirty rule edit", async () => {
    mockSettings([tornadoRule]);
    const user = userEvent.setup();
    renderPluginRoute(<EmergencyAlertsPage />, {
      path: "/plugins/emergency-alerts",
      role,
    });

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Edit rule")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Rule name"), " updated");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Leave without saving?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Edit rule")).not.toBeInTheDocument(),
    );
  });

  it("warns before leaving with unsaved monitor changes", async () => {
    mockSettings([], 300);
    renderPluginRoute(<EmergencyAlertsPage />, {
      path: "/plugins/emergency-alerts",
      role,
    });

    // The server value hydrates into local state first; editing before that
    // would be overwritten and read as clean.
    const pollInterval = await screen.findByLabelText("Poll interval");
    await waitFor(() => expect(pollInterval).toHaveValue("300"));
    fireEvent.change(pollInterval, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("link", { name: /Plugins/ }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Leave without saving?",
    });
    expect(
      within(dialog).getByText(
        "The monitor settings or alert rules have unsaved changes.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
  });
});
