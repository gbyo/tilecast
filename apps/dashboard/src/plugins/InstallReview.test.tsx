// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { installReview } from "./catalogFixtures";
import { InstallReview } from "./InstallReview";

async function renderReview(
  review: Parameters<typeof InstallReview>[0]["review"],
) {
  await i18n.changeLanguage("en");
  render(<InstallReview review={review} />);
}

describe("InstallReview capabilities", () => {
  afterEach(cleanup);

  it("says plainly that a content package asks for nothing special", async () => {
    await renderReview(installReview());
    expect(screen.getByText("No special permissions")).toBeInTheDocument();
    expect(screen.queryByText("Network access")).not.toBeInTheDocument();
    expect(screen.queryByText("Background activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Local storage")).not.toBeInTheDocument();
    expect(screen.queryByText("Studio interface")).not.toBeInTheDocument();
  });

  it("renders the requested capabilities in plain language", async () => {
    await renderReview(
      installReview({
        runtime: { module: "./runtime/plugin.wasm" },
        capabilities: {
          network: { hosts: ["api.example.com", "tiles.example.org"] },
          background: {
            jobs: [
              { id: "refresh-scores", intervalMinutes: 15 },
              { id: "prune", intervalMinutes: 1440 },
            ],
          },
          storage: true,
          studioUI: { entry: "./studio/index.html" },
        },
      }),
    );
    expect(screen.getByText("Network access")).toBeInTheDocument();
    expect(screen.getByText("Can connect to:")).toBeInTheDocument();
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(screen.getByText("tiles.example.org")).toBeInTheDocument();
    expect(screen.getByText("Local storage")).toBeInTheDocument();
    expect(
      screen.getByText("Stores this plugin's own data on the Tilecast server."),
    ).toBeInTheDocument();
    expect(screen.getByText("Background activity")).toBeInTheDocument();
    // How many jobs, not when: the schedule belongs to Background jobs.
    expect(screen.getByText("Runs 2 scheduled jobs.")).toBeInTheDocument();
    expect(screen.queryByText(/Every 15 minutes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Refresh scores/)).not.toBeInTheDocument();
    expect(screen.getByText("Studio interface")).toBeInTheDocument();
    expect(
      screen.getByText("Adds its own configuration interface to Studio."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No special permissions"),
    ).not.toBeInTheDocument();
  });

  it("keeps the runtime module and exact paths under technical details", async () => {
    const user = userEvent.setup();
    await renderReview(
      installReview({
        runtime: { module: "./runtime/plugin.wasm" },
        capabilities: { storage: true },
      }),
    );
    expect(screen.queryByText("./runtime/plugin.wasm")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByText("./runtime/plugin.wasm")).toBeInTheDocument();
    expect(screen.getByText("Runtime module")).toBeInTheDocument();
    expect(screen.getByText("widget · lobby")).toBeInTheDocument();
  });

  it("lists contributions by name and kind, not by path", async () => {
    await renderReview(
      installReview({
        contributions: [
          { type: "widget", path: "./widgets/sports-scores" },
          { type: "dataSource", path: "./data/live-games" },
        ],
      }),
    );
    expect(screen.getByText("Sports scores")).toBeInTheDocument();
    expect(screen.getByText("Live games")).toBeInTheDocument();
    expect(screen.getByText("Widget")).toBeInTheDocument();
    expect(screen.getByText("Data source")).toBeInTheDocument();
    expect(
      screen.getByText("Supplies data to compatible widgets."),
    ).toBeInTheDocument();
  });
});
