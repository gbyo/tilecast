// @vitest-environment jsdom

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { Tabs } from "../components/ui/tabs";
import { ScreenDetailTabs } from "./ScreensPage";
import type { ScreenDetailTab } from "./ScreensPage";
import { i18n } from "../i18n";

function renderTabs(tab: ScreenDetailTab = "overview", policyDirty = false) {
  const onValueChange = vi.fn();
  render(
    <Tabs value={tab} onValueChange={onValueChange}>
      <ScreenDetailTabs policyDirty={policyDirty} />
    </Tabs>,
  );
  return { onValueChange };
}

describe("ScreenDetailTabs", () => {
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("en");
  });

  it("keeps the primary navigation focused on operator workflows", async () => {
    const { onValueChange } = renderTabs();
    const user = userEvent.setup();

    for (const label of ["Overview", "Activity", "Settings"]) {
      expect(await screen.findByRole("tab", { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    expect(screen.queryByRole("tab", { name: "Content" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Device" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: /^Activity/ }));
    expect(onValueChange.mock.calls[0]?.[0]).toBe("activity");
  });

  it("keeps the unsaved badge on Settings while dirty", async () => {
    renderTabs("settings", true);

    expect(await screen.findByText("Unsaved")).toBeTruthy();
    expect(screen.getAllByText("Unsaved")).toHaveLength(1);
  });

  it("hides the unsaved badge while clean", async () => {
    renderTabs("settings", false);

    expect(await screen.findByRole("tab", { name: /^Settings/ })).toBeTruthy();
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("uses one responsive tablist instead of a separate mobile picker", async () => {
    renderTabs();

    const tablist = await screen.findByRole("tablist", { name: "Screen details" });
    expect(tablist.className).toContain("grid-cols-3");
    expect(screen.queryByRole("combobox", { name: "Screen details" })).toBeNull();
  });
});
