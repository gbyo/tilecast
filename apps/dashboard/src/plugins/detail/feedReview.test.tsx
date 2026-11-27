// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../../i18n";
import type { PluginDetailViewModel } from "./detailView";
import { FeedReviewSection } from "./FeedReviewSection";

afterEach(cleanup);

const view = (feeds: unknown[]) =>
  ({ plugin: { feeds } }) as unknown as PluginDetailViewModel;

describe("feed review", () => {
  it("names the Data Sources, images, and personal fields with retention", () => {
    render(
      <FeedReviewSection
        view={view([
          {
            id: "events",
            title: "Room meetings",
            provider: "room_sign.events",
            dataset: "instance",
            fields: 5,
            images: false,
            personal: [{ key: "title", label: "Title", retentionDays: 7 }],
          },
          {
            id: "items",
            title: "Menu items",
            provider: "menu_board.items",
            dataset: "organization",
            fields: 11,
            images: true,
            personal: [],
          },
        ])}
      />,
    );
    expect(screen.getByText("Room meetings")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Publishes a Data Source \(room_sign\.events\) for each item/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Title is personal data, deleted 7 days after it last changes",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Downloads pictures from the provider/),
    ).toBeInTheDocument();
  });

  it("shows nothing for a plugin without feeds", () => {
    const { container } = render(<FeedReviewSection view={view([])} />);
    expect(container).toBeEmptyDOMElement();
  });
});
