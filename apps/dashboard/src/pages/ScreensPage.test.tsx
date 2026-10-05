// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ScreenFleetTable } from "../components/ScreenFleetTable";
import { i18n } from "../i18n";
import type { PowerAssistResults, Screen, User } from "../api/types";
import { canManageScreens } from "../data/screens";
import {
  autostartSummary,
  autostartWarning,
  formatReportedStatus,
  reportsAutostart,
  reliabilityCapabilityWarning,
  resolveScreenDetail,
  ScreenGridCard,
  ScreenListContent,
  StatusLabel,
  zeroTouchReadiness,
} from "./ScreensPage";

const t = i18n.getFixedT("en", "screens");

describe("reliability status display", () => {
  it("formats reported status values without rendering response objects", () => {
    expect(formatReportedStatus("needs_attention", t)).toBe("needs attention");
    expect(formatReportedStatus(" ", t)).toBe("Not reported");
    expect(formatReportedStatus(undefined, t)).toBe("Not reported");
    expect(formatReportedStatus({ id: "player-1", name: "Lobby" }, t)).toBe(
      "Not reported",
    );
  });
});

const user = (role: User["role"]): User => ({
  id: "user",
  name: "Test User",
  username: "test",
  role,
  active: true,
  createdAt: new Date().toISOString(),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("screen management", () => {
  it("restricts pairing and credential management by role", () => {
    expect(canManageScreens(user("owner"))).toBe(true);
    expect(canManageScreens(user("administrator"))).toBe(true);
    expect(canManageScreens(user("editor"))).toBe(false);
    expect(canManageScreens(user("viewer"))).toBe(false);
  });

  it("shows a useful empty state and pairing action to administrators", () => {
    render(
      <MemoryRouter>
        <ScreenListContent screens={[]} loading={false} canManage />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "No screens paired" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pair screen" })).toHaveAttribute(
      "href",
      "/screens/pair",
    );
  });

  it("explains restrictions in the viewer empty state", () => {
    render(
      <MemoryRouter>
        <ScreenListContent screens={[]} loading={false} canManage={false} />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("link", { name: "Pair your first screen" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("An Owner or Administrator can approve new screens."),
    ).toBeInTheDocument();
  });

  it("renders status with text rather than color alone", () => {
    render(<StatusLabel status="revoked" />);
    expect(screen.getByText("Pairing revoked")).toBeInTheDocument();
  });

  it("renders an unknown status instead of crashing on incomplete data", () => {
    render(<StatusLabel status={null as unknown as Screen["status"]} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("keeps long fleet statuses inside a sized table column", () => {
    const item = {
      id: "screen-recent",
      name: "Library TV with a long screen name",
      description: "",
      location: "Edgewood Middle School",
      platform: "linux",
      playerVersion: "0.17.0",
      screenWidth: 1920,
      screenHeight: 1080,
      enabled: true,
      pairedAt: new Date().toISOString(),
      lastContactAt: new Date().toISOString(),
      status: "recent",
      hasActiveCredential: true,
    } as Screen;

    render(
      <MemoryRouter>
        <ScreenFleetTable
          screens={[item]}
          canManage={false}
          selectedIds={new Set()}
          csrfToken=""
          showLocation={false}
          onSelectionChange={vi.fn()}
        />
      </MemoryRouter>,
    );

    const table = screen.getByRole("table");
    expect(table).toHaveClass("table-fixed", "min-w-[59rem]");
    expect(
      screen.queryByRole("columnheader", { name: "Location" }),
    ).not.toBeInTheDocument();

    const status = screen.getByText("Recently online");
    expect(status.closest("td")).toHaveClass("w-[10rem]");
  });

  it("uses the dashboard record when detail data is incomplete", () => {
    const listed = {
      id: "screen-1",
      name: "Lobby",
      status: "online",
    } as Screen;
    const detail = {
      ...listed,
      name: "Lobby display",
      status: null as unknown as Screen["status"],
    };

    expect(resolveScreenDetail(detail, listed)).toMatchObject({
      name: "Lobby display",
      status: "online",
    });
    expect(resolveScreenDetail(undefined, listed)).toBe(listed);
  });

  it("renders live device status and accessible screen links", () => {
    // The table view is the desktop layout; narrow screens always get cards.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 1024px)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const item: Screen = {
      id: "screen-1",
      name: "Lobby",
      description: "",
      location: "Main entrance",
      platform: "android-tv",
      deviceManufacturer: "Google",
      deviceModel: "ADT-3",
      androidVersion: "14",
      playerVersion: "0.2.0",
      screenWidth: 1920,
      screenHeight: 1080,
      density: 2,
      locale: "en-US",
      timezone: "UTC",
      enabled: true,
      pairedAt: new Date().toISOString(),
      lastContactAt: new Date().toISOString(),
      status: "online",
      hasActiveCredential: true,
    };
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <ScreenListContent screens={[item]} loading={false} canManage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const table = within(screen.getByRole("table"));
    const link = table.getByRole("link", { name: /Lobby/ });
    expect(link).toHaveAttribute("href", "/screens/screen-1");
    // Only the screen name is a link. Device metadata sits outside the anchor so
    // location, platform, and resolution are not presented as separate targets.
    expect(link).toHaveTextContent("Lobby");
    expect(link).not.toHaveTextContent("android-tv");
    expect(link).not.toHaveTextContent("1920×1080");
    const row = screen.getByRole("row", { name: /Lobby/ });
    expect(within(row).getByText("Online")).toBeInTheDocument();
    expect(within(row).getByText(/1920×1080/)).toBeInTheDocument();
  });

  it("archives a screen from the fleet action menu with explicit confirmation", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 1024px)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const revoke = vi.spyOn(api, "revokeScreen").mockResolvedValue();
    const item = {
      id: "screen-1",
      name: "Lobby",
      description: "",
      location: "Main entrance",
      platform: "android-tv",
      deviceManufacturer: "Google",
      deviceModel: "ADT-3",
      playerVersion: "0.2.0",
      screenWidth: 1920,
      screenHeight: 1080,
      enabled: true,
      pairedAt: new Date().toISOString(),
      lastContactAt: new Date().toISOString(),
      status: "online",
      hasActiveCredential: true,
    } as Screen;

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <ScreenListContent
            screens={[item]}
            loading={false}
            canManage
            csrfToken="csrf"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const interaction = userEvent.setup();
    await interaction.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    await interaction.click(
      await screen.findByRole("menuitem", { name: "Archive screen…" }),
    );

    expect(
      screen.getByRole("alertdialog", { name: "Archive Lobby?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This removes the screen from the active fleet, revokes its player pairing, and preserves its history. The player must be paired again to return.",
      ),
    ).toBeInTheDocument();

    await interaction.click(
      screen.getByRole("button", { name: "Archive screen" }),
    );
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith(
        "screen-1",
        "Archived in Tilecast Studio",
        "csrf",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
  });

  it("states fleet health as labelled measures rather than a run-on sentence", () => {
    const item: Screen = {
      id: "screen-1",
      name: "Lobby",
      description: "",
      location: "Main entrance",
      platform: "android-tv",
      deviceManufacturer: "Google",
      deviceModel: "ADT-3",
      androidVersion: "14",
      playerVersion: "0.2.0",
      screenWidth: 1920,
      screenHeight: 1080,
      density: 2,
      locale: "en-US",
      timezone: "UTC",
      enabled: true,
      pairedAt: new Date().toISOString(),
      lastContactAt: new Date().toISOString(),
      status: "online",
      hasActiveCredential: true,
    };
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <ScreenListContent screens={[item]} loading={false} canManage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const summary = screen.getByRole("group", { name: "Fleet summary" });
    // Each measure pairs its own count with its own label, so no reading of the
    // summary produces "0 need attention".
    const measure = (text: string) =>
      within(summary).getByText(
        (_, element) =>
          element?.getAttribute("data-slot") === "badge" &&
          element.textContent === text,
      );
    expect(measure("0 Needs attention")).toBeInTheDocument();
    expect(measure("1 Online")).toBeInTheDocument();
  });

  it("requests a fresh preview for a visible grid card and shows its age", async () => {
    const capturedAt = new Date(Date.now() - 65_000).toISOString();
    const item = {
      id: "screen-1",
      name: "Lobby",
      location: "Main entrance",
      screenWidth: 1920,
      screenHeight: 1080,
      status: "online",
      lastContactAt: new Date().toISOString(),
    } as Screen;
    const renew = vi.spyOn(api, "renewScreenPreview").mockResolvedValue({
      active: true,
      captureIntervalSeconds: 20,
      captureNow: true,
    });
    vi.spyOn(api, "screenPreview").mockResolvedValue({
      screenId: item.id,
      status: "available",
      capturedAt,
      imageAvailable: true,
      updatedAt: capturedAt,
    });
    class ImmediateIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this,
        );
      }
      readonly scrollMargin = "";
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", ImmediateIntersectionObserver);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ScreenGridCard
            screen={item}
            csrfToken="csrf-token"
            selected={false}
            canManage={false}
            showLocation
            onSelect={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(renew).toHaveBeenCalledWith(item.id, true, "csrf-token"),
    );
    expect(
      await screen.findByLabelText("Snapshot captured 1m ago"),
    ).toBeInTheDocument();
    expect(
      screen.getByAltText("Latest preview from Lobby"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lobby" })).toHaveAttribute(
      "href",
      "/screens/screen-1",
    );
    expect(screen.getByRole("link", { name: "Open Lobby" })).toHaveAttribute(
      "href",
      "/screens/screen-1",
    );
    const interaction = userEvent.setup();
    await interaction.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Open screen" }),
    ).toBeTruthy();
  });

  it("moves screens to a location without resending their map positions", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 1024px)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const updateScreen = vi
      .spyOn(api, "updateScreen")
      .mockResolvedValue({} as Screen);
    const item = {
      id: "screen-1",
      name: "Lobby",
      description: "",
      location: "Main entrance",
      mapPositionOverride: { latitude: 34.157, longitude: -82.027 },
      platform: "android-tv",
      status: "online",
      enabled: true,
      hasActiveCredential: true,
    } as Screen;
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <ScreenListContent screens={[item]} loading={false} canManage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const interaction = userEvent.setup();
    await interaction.click(
      screen.getByRole("checkbox", { name: "Select Lobby" }),
    );
    await interaction.click(
      screen.getByRole("button", { name: "Move to location" }),
    );
    await waitFor(() => expect(updateScreen).toHaveBeenCalledTimes(1));
    // A position another editor saved after this list loaded must survive.
    expect(updateScreen.mock.calls[0]?.[1]).not.toHaveProperty(
      "mapPositionOverride",
    );
  });

  it("keeps card selection separate from navigation links", async () => {
    const item = {
      id: "screen-2",
      name: "Hallway",
      screenWidth: 1920,
      screenHeight: 1080,
      status: "online",
      lastContactAt: new Date().toISOString(),
    } as Screen;
    const onSelect = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    class SilentIntersectionObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", SilentIntersectionObserver);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ScreenGridCard
            screen={item}
            csrfToken=""
            selected={false}
            canManage
            showLocation
            onSelect={onSelect}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Select Hallway" });
    expect(checkbox.closest("a")).toBeNull();
    const interaction = userEvent.setup();
    checkbox.focus();
    await interaction.keyboard(" ");
    expect(onSelect).toHaveBeenCalledWith(true);
  });

  it("does not confuse requested Managed Kiosk with effective capability", () => {
    expect(
      reliabilityCapabilityWarning(
        {
          configuredMode: "managed_kiosk",
          effectiveMode: "standard",
          powerAssist: {
            deviceSleep: "untested",
            tvStandby: "untested",
            deviceWake: "untested",
            tvWake: "untested",
            inputSelection: "untested",
            tilecastStartup: "untested",
          },
        },
        t,
      ),
    ).toContain("not confirmed");
  });

  it("reports zero-touch readiness only after every safeguard is verified", () => {
    const powerAssist: PowerAssistResults = {
      deviceSleep: "untested",
      tvStandby: "untested",
      deviceWake: "untested",
      tvWake: "untested",
      inputSelection: "untested",
      tilecastStartup: "untested",
    };
    expect(
      zeroTouchReadiness(
        {
          commissioningState: "complete",
          accessibilityServiceState: "enabled",
          bootLaunchVerified: true,
          immersiveModeActive: true,
          keepScreenOn: true,
          cachedFallbackAvailable: true,
          updateReadiness: "ready",
          safeMode: false,
          powerAssist,
        },
        t,
      ),
    ).toBe("Ready");
    expect(
      zeroTouchReadiness(
        {
          commissioningState: "complete",
          accessibilityServiceState: "disabled",
          powerAssist,
        },
        t,
      ),
    ).toBe("Partially ready");
    expect(
      zeroTouchReadiness(
        {
          commissioningState: "complete",
          accessibilityServiceState: "unsupported",
          bootLaunchVerified: true,
          immersiveModeActive: true,
          keepScreenOn: true,
          cachedFallbackAvailable: false,
          updateReadiness: "ready",
          safeMode: false,
          powerAssist,
        },
        t,
      ),
    ).toBe("Partially ready");
    expect(
      zeroTouchReadiness(
        {
          commissioningState: "complete",
          accessibilityServiceState: "enabled",
          bootLaunchVerified: true,
          immersiveModeActive: true,
          keepScreenOn: true,
          cachedFallbackAvailable: false,
          updateReadiness: "ready",
          safeMode: false,
          powerAssist,
        },
        t,
      ),
    ).toBe("Ready");
  });

  it("separates an installed autostart unit from one verified at boot", () => {
    const powerAssist: PowerAssistResults = {
      deviceSleep: "untested",
      tvStandby: "untested",
      deviceWake: "untested",
      tvWake: "untested",
      inputSelection: "untested",
      tilecastStartup: "untested",
    };
    expect(
      autostartSummary(
        {
          autostartState: "installed",
          autostartTarget: "graphical-session.target",
          bootLaunchVerified: false,
          powerAssist,
        },
        t,
      ),
    ).toBe("Installed · graphical-session.target · not yet seen at boot");
    expect(
      autostartSummary(
        {
          autostartState: "installed",
          autostartTarget: "graphical-session.target",
          bootLaunchVerified: true,
          powerAssist,
        },
        t,
      ),
    ).toContain("verified at boot");
    expect(
      autostartSummary({ autostartState: "not_installed", powerAssist }, t),
    ).toBe("Not installed");
    expect(
      autostartSummary(
        {
          autostartState: "unsupported",
          autostartError: "player is not running as a managed AppImage",
          powerAssist,
        },
        t,
      ),
    ).toContain("managed AppImage");
    // A device whose probe failed is not the same as a device that reports
    // nothing, and the difference is what the operator has to act on.
    expect(
      autostartSummary(
        {
          autostartState: "unknown",
          autostartError: "EACCES /home/kiosk/.config",
          powerAssist,
        },
        t,
      ),
    ).toBe("Could not determine · EACCES /home/kiosk/.config");
    expect(autostartSummary({ powerAssist }, t)).toBe("Not reported");
  });

  it("hides Linux autostart controls for players that do not report it", () => {
    const powerAssist: PowerAssistResults = {
      deviceSleep: "untested",
      tvStandby: "untested",
      deviceWake: "untested",
      tvWake: "untested",
      inputSelection: "untested",
      tilecastStartup: "untested",
    };
    // Android, and Linux players predating autostart support.
    expect(
      reportsAutostart({ commissioningState: "complete", powerAssist }),
    ).toBe(false);
    expect(
      reportsAutostart({ autostartState: "not_installed", powerAssist }),
    ).toBe(true);
  });

  it("warns about the gaps the player cannot close by itself", () => {
    const powerAssist: PowerAssistResults = {
      deviceSleep: "untested",
      tvStandby: "untested",
      deviceWake: "untested",
      tvWake: "untested",
      inputSelection: "untested",
      tilecastStartup: "untested",
    };
    expect(
      autostartWarning({ autostartState: "not_installed", powerAssist }, t),
    ).toContain("will not return on its own");
    // default.target without lingering does not survive logout, and enabling
    // lingering needs root — so it has to be said, not silently tolerated.
    expect(
      autostartWarning(
        {
          autostartState: "installed",
          autostartTarget: "default.target",
          autostartLingerEnabled: false,
          powerAssist,
        },
        t,
      ),
    ).toContain("enable-linger");
    expect(
      autostartWarning({ autostartState: "needs_attention", powerAssist }, t),
    ).toContain("not report it as enabled");
    // A failed probe carries its own reason, and must not read as healthy.
    expect(
      autostartWarning(
        {
          autostartState: "unknown",
          autostartError: "EACCES /home/kiosk/.config",
          powerAssist,
        },
        t,
      ),
    ).toContain("EACCES /home/kiosk/.config");
    expect(
      autostartWarning(
        {
          autostartState: "installed",
          autostartTarget: "graphical-session.target",
          autostartLingerEnabled: false,
          powerAssist,
        },
        t,
      ),
    ).toBeUndefined();
    // Android screens never see an autostart warning.
    expect(
      autostartWarning({ commissioningState: "complete", powerAssist }, t),
    ).toBe(undefined);
  });
});
