// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { SidebarProvider, useSidebar } from "../components/ui/sidebar";
import { SettingsShell } from "./SettingsShell";
import {
  settingsNavigation,
  type SettingsSectionId,
} from "./settingsNavigation";

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

function Location() {
  return <output aria-label="location">{useLocation().pathname}</output>;
}

function PrimarySidebarState() {
  return <output aria-label="primary sidebar">{useSidebar().state}</output>;
}

function renderShell({
  active = "general",
  dirty = [],
  onNavigate = () => true,
}: {
  active?: SettingsSectionId;
  dirty?: SettingsSectionId[];
  onNavigate?: (next: SettingsSectionId) => boolean;
} = {}) {
  return render(
    <MemoryRouter initialEntries={["/settings/general"]}>
      <SidebarProvider>
        <SettingsShell
          active={active}
          dirty={new Set(dirty)}
          onNavigate={onNavigate}
        >
          <Location />
          <PrimarySidebarState />
        </SettingsShell>
      </SidebarProvider>
    </MemoryRouter>,
  );
}

const sections = () =>
  screen.getByRole("navigation", { name: "Settings sections" });

describe("SettingsShell navigation", () => {
  it("renders every group and section as a link", () => {
    renderShell();
    const nav = sections();
    for (const group of settingsNavigation) {
      expect(within(nav).getByText(group.label)).toBeInTheDocument();
      for (const item of group.items) {
        expect(
          within(nav).getByRole("link", { name: item.label }),
        ).toHaveAttribute("href", `/settings/${item.path}`);
      }
    }
  });

  it("marks only the active section as current", () => {
    renderShell({ active: "presentation-networks" });
    const nav = sections();
    const current = within(nav).getByRole("link", {
      name: "Presentation Networks",
    });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveAttribute("data-active");
    expect(
      within(nav)
        .getAllByRole("link")
        .filter((link) => link.hasAttribute("aria-current")),
    ).toEqual([current]);
    const general = within(nav).getByRole("link", { name: "General" });
    expect(general).not.toHaveAttribute("aria-current");
    expect(general).not.toHaveAttribute("data-active");
  });

  it("shows a text unsaved indicator on dirty sections", () => {
    renderShell({ dirty: ["takeover"] });
    const nav = sections();
    expect(
      within(nav).getByRole("link", { name: "Takeovers and commands" }),
    ).toHaveAccessibleDescription("Unsaved");
    expect(within(nav).getAllByText("Unsaved")).toHaveLength(1);
    expect(
      within(nav).getByRole("link", { name: "General" }),
    ).not.toHaveAccessibleDescription();
  });

  it("uses translated labels", async () => {
    await i18n.changeLanguage("es");
    renderShell({ dirty: ["branding"] });
    const nav = screen.getByRole("navigation", {
      name: i18n.t("settings:shell.sectionsLabel"),
    });
    const group = i18n.t("settings:nav.groups.organization");
    const label = i18n.t("settings:nav.items.branding");
    const badge = i18n.t("settings:shell.unsavedBadge");
    expect(group).not.toBe("Organization");
    expect(within(nav).getByText(group)).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: label }),
    ).toHaveAccessibleDescription(badge);
  });

  it("navigates immediately from a clean section", async () => {
    const onNavigate = vi.fn(() => true);
    renderShell({ onNavigate });
    await userEvent.click(
      within(sections()).getByRole("link", { name: "Data retention" }),
    );
    expect(onNavigate).toHaveBeenCalledWith("retention");
    expect(screen.getByLabelText("location")).toHaveTextContent(
      "/settings/operations/retention",
    );
  });

  it("lets onNavigate hold navigation for a dirty section", async () => {
    const onNavigate = vi.fn(() => false);
    renderShell({ dirty: ["general"], onNavigate });
    await userEvent.click(
      within(sections()).getByRole("link", { name: "Data retention" }),
    );
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("retention");
    expect(screen.getByLabelText("location")).toHaveTextContent(
      "/settings/general",
    );
  });
});

describe("SettingsShell secondary sidebar", () => {
  it("stays expanded while the shortcut toggles the primary sidebar", async () => {
    renderShell();
    const primary = screen.getByLabelText("primary sidebar");
    expect(primary).toHaveTextContent("expanded");
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(primary).toHaveTextContent("collapsed");
    const nav = sections();
    expect(within(nav).getByRole("link", { name: "General" })).toBeVisible();
    expect(nav.querySelector('[data-slot="sidebar"]')).not.toHaveAttribute(
      "data-state",
    );
  });
});

describe("SettingsShell mobile section picker", () => {
  it("navigates through the localized select", async () => {
    await i18n.changeLanguage("es");
    const onNavigate = vi.fn(() => true);
    renderShell({ dirty: ["users"], onNavigate });
    const user = userEvent.setup();
    const picker = screen.getByRole("combobox", {
      name: i18n.t("settings:shell.sectionLabel"),
    });
    expect(picker).toHaveTextContent(i18n.t("settings:nav.items.general"));
    await user.click(picker);
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox).getByRole("option", {
        name: `${i18n.t("settings:nav.items.users")}${i18n.t("settings:shell.unsavedSuffix")}`,
      }),
    ).toBeInTheDocument();
    await user.click(
      within(listbox).getByRole("option", {
        name: i18n.t("settings:nav.items.retention"),
      }),
    );
    expect(onNavigate).toHaveBeenCalledWith("retention");
    expect(screen.getByLabelText("location")).toHaveTextContent(
      "/settings/operations/retention",
    );
  });
});

describe("SettingsShell workspace sections", () => {
  it("gives the Dependency Explorer the full width and a Sheet of sections", async () => {
    const onNavigate = vi.fn(() => true);
    renderShell({ active: "dependency-graph", onNavigate });
    expect(
      screen.getByRole("heading", { level: 1, name: "Dependency Explorer" }),
    ).toBeInTheDocument();
    // No permanent column and no mobile picker.
    expect(
      screen.queryByRole("navigation", { name: "Settings sections" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Settings section" }),
    ).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Settings sections" }));
    const sheet = await screen.findByRole("dialog", {
      name: "Settings sections",
    });
    const nav = within(sheet).getByRole("navigation", {
      name: "Settings sections",
    });
    expect(
      within(nav).getByRole("link", { name: "Dependency Explorer" }),
    ).toHaveAttribute("aria-current", "page");
    await user.click(within(nav).getByRole("link", { name: "Data retention" }));
    expect(onNavigate).toHaveBeenCalledWith("retention");
    expect(screen.getByLabelText("location")).toHaveTextContent(
      "/settings/operations/retention",
    );
  });

  it("keeps the standard layout for ordinary sections", () => {
    renderShell({ active: "general" });
    expect(sections()).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Settings sections" }),
    ).not.toBeInTheDocument();
  });
});
