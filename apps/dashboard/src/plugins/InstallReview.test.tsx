// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

  it("renders nothing server-side for a plain content package", async () => {
    await renderReview(installReview());
    expect(screen.queryByText("Server module")).not.toBeInTheDocument();
    expect(screen.queryByText("Outbound HTTPS hosts")).not.toBeInTheDocument();
    expect(screen.queryByText("Background jobs")).not.toBeInTheDocument();
    expect(screen.queryByText("Private storage")).not.toBeInTheDocument();
    expect(screen.queryByText("Studio interface")).not.toBeInTheDocument();
  });

  it("renders the requested runtime module and capabilities", async () => {
    await renderReview(
      installReview({
        runtime: { module: "./runtime/plugin.wasm" },
        capabilities: {
          network: { hosts: ["api.example.com", "tiles.example.org"] },
          background: {
            jobs: [
              { id: "refresh", intervalMinutes: 15 },
              { id: "prune", intervalMinutes: 1440 },
            ],
          },
          storage: true,
          studioUI: { entry: "./studio/index.html" },
        },
      }),
    );
    expect(screen.getByText("Server module")).toBeInTheDocument();
    expect(screen.getByText("./runtime/plugin.wasm")).toBeInTheDocument();
    expect(screen.getByText("Outbound HTTPS hosts")).toBeInTheDocument();
    expect(
      screen.getByText("api.example.com, tiles.example.org"),
    ).toBeInTheDocument();
    expect(screen.getByText("Background jobs")).toBeInTheDocument();
    expect(
      screen.getByText("refresh · every 15 min, prune · every 1440 min"),
    ).toBeInTheDocument();
    expect(screen.getByText("Private storage")).toBeInTheDocument();
    expect(screen.getByText("Granted")).toBeInTheDocument();
    expect(screen.getByText("Studio interface")).toBeInTheDocument();
    expect(screen.getByText("./studio/index.html")).toBeInTheDocument();
  });

  it("renders granted capabilities without a runtime module", async () => {
    await renderReview(
      installReview({
        capabilities: { studioUI: { entry: "./studio/index.html" } },
      }),
    );
    expect(screen.queryByText("Server module")).not.toBeInTheDocument();
    expect(screen.getByText("Studio interface")).toBeInTheDocument();
  });
});
