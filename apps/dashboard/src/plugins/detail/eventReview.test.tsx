// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../../i18n";
import type { PluginEventReview } from "../../api/types";
import type { PluginDetailViewModel } from "./detailView";
import { EventReviewSection } from "./EventReviewSection";

afterEach(cleanup);

const view = (events?: PluginEventReview) =>
  ({ plugin: { events } }) as unknown as PluginDetailViewModel;

describe("event review", () => {
  it("separates published and received events and names each publisher", () => {
    render(
      <EventReviewSection
        view={view({
          publishes: [
            {
              event: "plugin.room_sign.meeting_started@1",
              title: "Meeting started",
              fields: 3,
            },
          ],
          subscribes: [
            { event: "takeover.started@1", publisher: "core" },
            {
              event: "plugin.bell_schedule.period_started@1",
              publisher: "bell_schedule",
              publisherName: "Bell Schedule",
            },
            { event: "plugin.gone.thing@1", publisher: "gone" },
          ],
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Events" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Publishes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Receives" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Meeting started")).toBeInTheDocument();
    expect(
      screen.getByText("plugin.room_sign.meeting_started@1"),
    ).toBeInTheDocument();
    expect(screen.getByText(/3 fields/)).toBeInTheDocument();
    expect(screen.getByText("A Takeover starts")).toBeInTheDocument();
    expect(screen.getByText("Tilecast event")).toBeInTheDocument();
    expect(screen.getAllByText("Plugin event")).toHaveLength(2);
    expect(screen.getByText(/Published by Tilecast/)).toBeInTheDocument();
    expect(
      screen.getByText(/Published by Bell Schedule \(bell_schedule\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/which this Tilecast release does not include/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/installing the plugin does not give it more access/),
    ).toBeInTheDocument();
  });

  it("shows nothing for a plugin without events", () => {
    const { container } = render(
      <EventReviewSection view={view({ publishes: [], subscribes: [] })} />,
    );
    expect(container).toBeEmptyDOMElement();
    const none = render(<EventReviewSection view={view()} />);
    expect(none.container).toBeEmptyDOMElement();
  });
});
