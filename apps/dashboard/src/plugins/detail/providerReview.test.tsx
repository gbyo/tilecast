// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../../i18n";
import type { PluginProviderReview } from "../../api/types";
import type { PluginDetailViewModel } from "./detailView";
import { ProviderReviewSection } from "./ProviderReviewSection";

afterEach(cleanup);

const view = (providers?: PluginProviderReview) =>
  ({ plugin: { providers } }) as unknown as PluginDetailViewModel;

describe("provider review", () => {
  it("names each channel and each check with the kinds it reads", () => {
    render(
      <ProviderReviewSection
        view={view({
          channels: [{ id: "push", title: "ntfy" }],
          checks: [
            {
              id: "lint",
              title: "Readability",
              kinds: ["playlist", "media_item"],
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Services for Tilecast" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ntfy")).toBeInTheDocument();
    expect(
      screen.getByText(/delivers the notifications Tilecast already sends/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(playlists, media\)/)).toBeInTheDocument();
  });

  it("renders nothing without providers", () => {
    const { container } = render(
      <ProviderReviewSection view={view({ channels: [], checks: [] })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
