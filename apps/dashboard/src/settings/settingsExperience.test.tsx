// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingDefinition } from "../api/types";
import { SettingControl } from "./SettingControl";
import { dependencyState } from "./settingDependencies";
import { enumLabel, groupsFor } from "./settingDisplay";
import { sectionFromPath, settingsNavigation } from "./settingsNavigation";
import { normalizeSettingValues } from "./settingValues";

afterEach(cleanup);
const definition = (
  partial: Partial<SettingDefinition>,
): SettingDefinition => ({
  key: "test.setting",
  category: "playback",
  type: "string",
  title: "Test setting",
  default: "",
  scope: "organization",
  sensitive: false,
  restartRequired: false,
  immediate: false,
  futureOnly: false,
  ...partial,
});

describe("settings presentation", () => {
  it("uses grouped URL-backed navigation", () => {
    expect(settingsNavigation.map((group) => group.label)).toEqual([
      "Organization",
      "Content and playback",
      "Player management",
      "Operations",
    ]);
    expect(sectionFromPath("/settings/player/reliability")).toBe("reliability");
    expect(sectionFromPath("/settings")).toBe("general");
    // Automatic weather alerts are the Emergency Alerts plugin; what is left
    // in Settings is the policy for a Takeover someone starts by hand.
    expect(
      settingsNavigation
        .flatMap((group) => group.items)
        .find((item) => item.id === "takeover")?.label,
    ).toBe("Takeovers and commands");
  });

  it("renders booleans as an accessible switch", () => {
    const change = vi.fn();
    render(
      <SettingControl
        definition={definition({ type: "bool", title: "Launch after boot" })}
        value={false}
        onChange={change}
      />,
    );
    const control = screen.getByRole("switch", { name: "Launch after boot" });
    expect(control).toHaveAttribute("aria-checked", "false");
    fireEvent.click(control);
    expect(change).toHaveBeenCalledWith(true);
  });

  it("keeps enum storage values while showing human labels", async () => {
    expect(enumLabel("managed_kiosk")).toBe("Managed Kiosk");
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingControl
        definition={definition({
          type: "enum",
          title: "Cookie policy",
          allowed: ["first_party", "first_and_third_party"],
        })}
        value="first_party"
        onChange={change}
      />,
    );
    const control = screen.getByRole("combobox", { name: "Cookie policy" });
    expect(control).toHaveTextContent("First-party cookies");
    await user.click(control);
    await user.click(
      await screen.findByRole("option", {
        name: "First- and third-party cookies",
      }),
    );
    expect(change).toHaveBeenCalledWith("first_and_third_party");
  });

  it("edits weekdays without exposing numeric ISO values", () => {
    const change = vi.fn();
    render(
      <SettingControl
        definition={definition({ type: "weekday_list", title: "Active days" })}
        value={[1, 2, 3, 4, 5]}
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    expect(change).toHaveBeenCalledWith([1, 2, 3, 4, 5, 6]);
    expect(screen.queryByDisplayValue("1, 2, 3, 4, 5")).not.toBeInTheDocument();
  });

  it("converts byte display units without changing stored bytes", () => {
    const change = vi.fn();
    render(
      <SettingControl
        definition={definition({
          key: "player.cache.max_bytes",
          type: "int64",
          title: "Maximum cache size",
          min: 1024 ** 2,
          max: 1024 ** 4,
        })}
        value={8 * 1024 ** 3}
        onChange={change}
      />,
    );
    expect(
      screen.getByRole("spinbutton", { name: "Maximum cache size" }),
    ).toHaveValue(8);
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Maximum cache size" }),
      { target: { value: "12" } },
    );
    expect(change).toHaveBeenCalledWith(12 * 1024 ** 3);
  });

  it("presents second-backed durations in readable units", () => {
    const change = vi.fn();
    render(
      <SettingControl
        definition={definition({
          key: "player.sync.manifest_seconds",
          type: "int",
          title: "Manifest reconciliation interval",
          min: 60,
          max: 86400,
        })}
        value={300}
        onChange={change}
      />,
    );
    expect(
      screen.getByRole("spinbutton", {
        name: "Manifest reconciliation interval",
      }),
    ).toHaveValue(5);
    expect(
      screen.getByRole("combobox", {
        name: "Manifest reconciliation interval unit",
      }),
    ).toHaveTextContent("minutes");
    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "Manifest reconciliation interval",
      }),
      { target: { value: "10" } },
    );
    expect(change).toHaveBeenCalledWith(600);
  });

  it("normalizes minute-precision local times and uses canonical timezone options", async () => {
    const timeChange = vi.fn();
    render(
      <SettingControl
        definition={definition({
          key: "power.active_hours_end",
          type: "local_time",
          title: "End time",
        })}
        value="16:00:00"
        onChange={timeChange}
      />,
    );
    const time = screen.getByLabelText("End time");
    expect(time).toHaveValue("16:00");
    expect(time).toHaveAttribute("step", "60");
    fireEvent.change(time, { target: { value: "17:30" } });
    expect(timeChange).toHaveBeenCalledWith("17:30");
    cleanup();

    const timezoneChange = vi.fn();
    render(
      <SettingControl
        definition={definition({
          key: "organization.timezone",
          type: "timezone",
          title: "Default timezone",
        })}
        value="EST"
        onChange={timezoneChange}
      />,
    );
    const timezone = screen.getByRole("combobox", {
      name: "Default timezone",
    });
    expect(timezone).toHaveTextContent("Eastern Time");

    const user = userEvent.setup();
    await user.click(timezone);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    await user.click(
      await screen.findByRole("option", { name: "Pacific Time" }),
    );
    expect(timezoneChange).toHaveBeenCalledWith("America/Los_Angeles");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    expect(
      normalizeSettingValues(
        {
          "organization.timezone": "EST",
          "power.active_hours_start": "06:30:00",
          "power.active_hours_end": "16:00:00",
        },
        [
          definition({ key: "organization.timezone", type: "timezone" }),
          definition({ key: "power.active_hours_start", type: "local_time" }),
          definition({ key: "power.active_hours_end", type: "local_time" }),
        ],
      ),
    ).toMatchObject({
      "organization.timezone": "America/New_York",
      "power.active_hours_start": "06:30",
      "power.active_hours_end": "16:00",
    });
  });

  it("centralizes dependencies and meaningful subsections", () => {
    expect(enumLabel("bouncing_logo")).toBe("Bouncing Tilecast logo");
    expect(enumLabel("black")).toBe("Black screen");
    expect(
      dependencyState("power.active_hours_days", {
        "power.active_hours_enabled": false,
      }),
    ).toMatchObject({ disabled: true });
    expect(
      dependencyState("power.outside_active_hours_text", {
        "power.active_hours_enabled": true,
        "power.outside_active_hours_display": "black",
      }),
    ).toMatchObject({ disabled: true });
    expect(
      dependencyState("power.outside_active_hours_text", {
        "power.active_hours_enabled": true,
        "power.outside_active_hours_display": "custom_text",
      }),
    ).toEqual({ disabled: false });
    const groups = groupsFor("playback", [
      definition({
        key: "player.cache.max_bytes",
        type: "int64",
        title: "Maximum cache size",
      }),
    ]);
    expect(groups.at(0)?.title).toBe("Storage and delivery");

    const reliabilityGroups = groupsFor("reliability", [
      definition({
        key: "managed_kiosk.lock_task_enabled",
        category: "reliability",
        type: "bool",
        title: "Lock task",
        scope: "policy",
      }),
      definition({
        key: "linux_kiosk.fullscreen_enabled",
        category: "reliability",
        type: "bool",
        title: "Kiosk fullscreen",
        scope: "policy",
      }),
    ]);
    expect(reliabilityGroups.map((group) => group.title)).toEqual([
      "Android Managed Kiosk",
      "Linux kiosk",
    ]);
  });
});
