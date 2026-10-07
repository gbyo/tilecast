// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enScreens from "../../locales/en/screens.json";
import type { ReliabilityStatus } from "../../api/types";
import { BROWSER_COMMANDS } from "./browserCapabilities.gen";
import { BrowserCommandPanel } from "./BrowserCommandPanel";
import { BrowserPlayerDiagnostics } from "./BrowserPlayerDiagnostics";
import { browserFacts, browserFindings } from "./browserDiagnostics";

const GIB = 1024 ** 3;
const reliability: ReliabilityStatus = {
  foregroundState: "foreground",
  activeHoursState: "active",
  browser: {
    browserName: "edge",
    browserMajorVersion: 154,
    displayMode: "standalone_pwa",
    audioUnlocked: true,
    wakeLock: "active",
    storagePersistence: "persistent",
    storageUsageBytes: 3.8 * GIB,
    storageQuotaBytes: 12 * GIB,
    offlineContent: "ready",
    serviceWorker: "controlling",
  },
  powerAssist: {
    deviceSleep: "untested",
    tvStandby: "untested",
    deviceWake: "untested",
    tvWake: "untested",
    inputSelection: "untested",
    tilecastStartup: "untested",
  },
};

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        data: { id: "slot", screenId: "screen-1", recoveryEnabled: true },
      }),
      { status: 200 },
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCard(overrides: Partial<ReliabilityStatus> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BrowserPlayerDiagnostics
        screenId="screen-1"
        screenStatus="online"
        playbackState="playing"
        reliability={{ ...reliability, ...overrides }}
      />
    </QueryClientProvider>,
  );
}

describe("Browser Player diagnostics card", () => {
  it("shows the facts in plain words", async () => {
    renderCard();
    expect(await screen.findByText("Microsoft Edge 154")).toBeTruthy();
    expect(screen.getByText("Installed app")).toBeTruthy();
    expect(screen.getByText("Foreground")).toBeTruthy();
    expect(screen.getByText("Not required in an installed app")).toBeTruthy();
    expect(
      screen.getByText(/Persistent · 3\.8 GiB used of 12 GiB/),
    ).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(await screen.findByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Managed by server")).toBeTruthy();
  });

  it("says best-effort storage may be reclaimed, without calling it a playback problem", async () => {
    renderCard({
      browser: { ...reliability.browser, storagePersistence: "best_effort" },
    });
    expect(await screen.findByText(/Best effort · 3\.8 GiB/)).toBeTruthy();
    expect(screen.getByText("Downloaded content may be removed")).toBeTruthy();
    expect(screen.getAllByText("Recommended").length).toBeGreaterThan(0);
    expect(screen.queryByText("Affects playback")).toBeNull();
  });

  it("marks a hidden page as affecting playback, with text and not only color", async () => {
    renderCard({ foregroundState: "background" });
    expect(await screen.findByText("Player is in the background")).toBeTruthy();
    expect(screen.getByText("Affects playback")).toBeTruthy();
  });

  it("explains the display's absent features instead of hiding them", async () => {
    renderCard();
    expect(await screen.findByText("Watch Live is not available")).toBeTruthy();
  });
});

describe("Browser Player command panel", () => {
  it("offers exactly the commands in the capability matrix", () => {
    const onCommand = vi.fn();
    render(<BrowserCommandPanel pending={false} onCommand={onCommand} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(BROWSER_COMMANDS.length);
    for (const name of [
      "Sync now",
      "Reload playback",
      "Identify screen",
      "Retry current item",
      "Skip current item",
    ])
      expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(
      screen.queryByText(/restart|cache|display power/i, {
        selector: "button",
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Identify screen" }));
    expect(onCommand).toHaveBeenCalledWith("identify_screen", {
      durationSeconds: 30,
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip current item" }));
    expect(onCommand).toHaveBeenLastCalledWith("skip_current_item", {});
  });

  it("disables every command while one is being sent", () => {
    render(<BrowserCommandPanel pending onCommand={vi.fn()} />);
    for (const button of screen.getAllByRole("button"))
      expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Browser Player strings", () => {
  const browser = enScreens.browser as unknown as {
    diagnostics: Record<string, unknown>;
    commands: {
      labels: Record<string, string>;
      details: Record<string, string>;
    };
  };
  const lookup = (path: string) =>
    path
      .split(".")
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown> | undefined)?.[key],
        browser.diagnostics,
      );

  it("has text for every fact value, label and finding the model can produce", () => {
    const widest = {
      reliability: {
        ...reliability,
        foregroundState: "frozen",
        browser: {
          ...reliability.browser,
          displayMode: "browser_tab" as const,
          fullscreenActive: false,
          wakeLock: "denied" as const,
          audioUnlocked: false,
          storagePersistence: "best_effort" as const,
          offlineContent: "repairing" as const,
          serviceWorker: "update_waiting" as const,
        },
      },
      screenStatus: "online",
      playbackState: "playing",
      lastPlaybackError: "x",
      recoveryEnabled: false,
    };
    const facts = browserFacts(widest, { bytes: String });
    for (const fact of facts) {
      expect(lookup(`facts.${fact.id}`), `facts.${fact.id}`).toBeTypeOf(
        "string",
      );
      expect(lookup(fact.value), fact.value).toBeTypeOf("string");
    }
    for (const finding of [
      ...browserFindings(widest),
      ...browserFindings({
        ...widest,
        reliability: { ...widest.reliability, foregroundState: "background" },
      }),
      ...browserFindings({
        ...widest,
        reliability: {
          ...widest.reliability,
          browser: {
            ...widest.reliability.browser,
            offlineContent: "not_prepared" as const,
          },
        },
      }),
    ]) {
      expect(lookup(`findings.${finding.id}.title`), finding.id).toBeTypeOf(
        "string",
      );
      expect(lookup(`findings.${finding.id}.body`), finding.id).toBeTypeOf(
        "string",
      );
      expect(lookup(`severity.${finding.severity}`)).toBeTypeOf("string");
    }
  });

  it("has a label and detail for every supported command", () => {
    for (const command of BROWSER_COMMANDS) {
      expect(browser.commands.labels[command.type], command.type).toBeTypeOf(
        "string",
      );
      expect(browser.commands.details[command.type], command.type).toBeTypeOf(
        "string",
      );
    }
  });
});
