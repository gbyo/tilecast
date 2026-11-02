// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { PlayerHealth, ReliabilityStatus } from "../../api/types";
import { PlayerHealthSummary } from "./PlayerHealthSummary";

afterEach(() => {
  cleanup();
});

const baseHealth: PlayerHealth = {
  state: "recovering",
  observedAt: "2026-10-08T18:00:00Z",
  cause: "recovery_in_progress",
  rendererState: "starting",
  lastProgressAt: "2026-10-08T17:55:00Z",
  lastRecoveryReason: "recovery",
  lastRecoveryAt: "2026-10-08T17:50:00Z",
  recoveryLevel: 2,
};

function renderSummary(
  health?: PlayerHealth,
  reliability?: ReliabilityStatus,
  loading = false,
) {
  return render(
    <MemoryRouter>
      <PlayerHealthSummary
        health={health}
        reliability={reliability}
        screenId="screen-1"
        loading={loading}
      />
    </MemoryRouter>,
  );
}

describe("PlayerHealthSummary", () => {
  it("names the current state with its cause and last recovery", () => {
    renderSummary(baseHealth);
    expect(screen.getByText("Player health")).toBeInTheDocument();
    expect(screen.getByText("Recovering")).toBeInTheDocument();
    expect(screen.getByText("Recovery in progress")).toBeInTheDocument();
    expect(screen.getByText(/recovery ·/)).toBeInTheDocument();
    expect(screen.getByText(/level 2/)).toBeInTheDocument();
  });

  it("shows renderer facts and links into activity, commands, and updates", () => {
    renderSummary(baseHealth, {
      powerAssist: {
        deviceSleep: "untested",
        tvStandby: "untested",
        deviceWake: "untested",
        tvWake: "untested",
        inputSelection: "untested",
        tilecastStartup: "untested",
      },
      lastRendererFailure: "rejected",
      rendererRestartCount: 4,
    });
    expect(screen.getByText(/Starting/)).toBeInTheDocument();
    expect(screen.getByText(/rejected/)).toBeInTheDocument();
    expect(screen.getByText(/4 restarts/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Activity" })).toHaveAttribute(
      "href",
      "/screens/screen-1?tab=activity",
    );
    expect(screen.getByRole("link", { name: "Commands" })).toHaveAttribute(
      "href",
      "/screens/screen-1?tab=commands",
    );
    expect(
      screen.getByRole("link", { name: "Player updates" }),
    ).toHaveAttribute("href", "/settings/player/updates");
  });

  it("keeps intentional sleep quiet and shows update failures when relevant", () => {
    const { container } = renderSummary({
      state: "sleeping_or_disabled",
      cause: "display_sleep",
    });
    expect(screen.getByText("Sleeping or disabled")).toBeInTheDocument();
    // No destructive treatment for ordinary intentional sleep.
    expect(container.querySelector(".bg-destructive")).toBeNull();

    cleanup();
    renderSummary({
      state: "needs_intervention",
      cause: "update_failed",
      updateState: "failed",
      updateError: "verify_failed",
    });
    expect(screen.getByText("Needs intervention")).toBeInTheDocument();
    expect(screen.getByText(/verify_failed/)).toBeInTheDocument();
  });

  it("renders loading and absent states without crashing", () => {
    renderSummary(undefined, undefined, true);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading player health…",
    );
    cleanup();
    const { container } = renderSummary(undefined, undefined, false);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders unknown cause codes as readable text", () => {
    renderSummary({
      state: "safe_mode",
      cause: "renderer recovery exhausted repeatedly",
    });
    expect(
      screen.getByText("renderer recovery exhausted repeatedly"),
    ).toBeInTheDocument();
  });
});
