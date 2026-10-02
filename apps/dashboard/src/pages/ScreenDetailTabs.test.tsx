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
  const onSelect = vi.fn();
  const onValueChange = vi.fn();
  render(
    <Tabs value={tab} onValueChange={onValueChange}>
      <ScreenDetailTabs
        tab={tab}
        policyDirty={policyDirty}
        onSelect={onSelect}
      />
    </Tabs>,
  );
  return { onSelect, onValueChange };
}

describe("ScreenDetailTabs", () => {
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("en");
  });

  it("lists every destination in the desktop strip", async () => {
    const { onValueChange } = renderTabs();
    const user = userEvent.setup();

    for (const label of [
      "Overview",
      "Content",
      "Activity",
      "Device",
      "Settings",
    ]) {
      expect(
        await screen.findByRole("tab", { name: new RegExp(`^${label}`) }),
      ).toBeTruthy();
    }
    await user.click(screen.getByRole("tab", { name: /^Device/ }));
    expect(onValueChange.mock.calls[0]?.[0]).toBe("device");
  });

  it("switches sections through the narrow picker", async () => {
    const { onSelect } = renderTabs();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("combobox", { name: "Screen details" }),
    );
    await user.click(await screen.findByRole("option", { name: "Device" }));
    expect(onSelect).toHaveBeenCalledWith("device");
  });

  it("keeps the unsaved badge visible on both surfaces while dirty", async () => {
    renderTabs("settings", true);

    expect(await screen.findAllByText("Unsaved")).toHaveLength(2);
  });

  it("hides the unsaved badge while clean", async () => {
    renderTabs("settings", false);

    expect(await screen.findByRole("tab", { name: /^Settings/ })).toBeTruthy();
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("shows one navigation surface per breakpoint", async () => {
    renderTabs();

    const strip = (await screen.findByRole("tablist")).parentElement;
    expect(strip?.className).toContain("hidden");
    expect(strip?.className).toContain("sm:contents");
    const picker = (
      await screen.findByRole("combobox", { name: "Screen details" })
    ).closest("div[class*='sm:hidden']");
    expect(picker).not.toBeNull();
  });
});
