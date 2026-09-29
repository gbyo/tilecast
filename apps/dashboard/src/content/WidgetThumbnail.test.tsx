// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WidgetThumbnail, hasWidgetThumbnail } from "./WidgetThumbnail";

// Every Widget the gallery can offer. Legacy Widgets are keyed by provider id; release
// definitions are keyed by their declared thumbnail name. Adding a Widget without a
// preview should fail here rather than quietly showing the generic placeholder.
const GALLERY_WIDGETS = [
  "website",
  "youtube",
  "clock",
  "date",
  "qrcode",
  "countdown",
  "world_clock",
  "ticker",
  "menu",
  "list",
  "table",
  "agenda",
  "metric",
  "cards",
  "weather",
  "spotlight",
  "stat_grid",
  "chart",
  "progress",
  "timeline",
  "status",
  "text-notice",
  "image-notice",
  "qr-call-to-action",
  "fundraising-thermometer",
  "news-feed",
  "espn",
  "bbc-news",
  "sky-news",
  "the-guardian",
  "rss",
  "google-sheets",
  "google-slides",
  "canva",
  "grafana",
  "power-bi",
  "tableau",
  "looker-studio",
  "airtable",
  "smartsheet",
];

afterEach(cleanup);

describe("WidgetThumbnail", () => {
  it("draws a distinct preview for every Widget in the gallery", () => {
    const missing = GALLERY_WIDGETS.filter((name) => !hasWidgetThumbnail(name));
    expect(missing).toEqual([]);
  });

  it("labels the preview for screen readers", () => {
    const { getByRole } = render(
      <WidgetThumbnail name="metric" label="Metric" />,
    );
    expect(getByRole("img").getAttribute("aria-label")).toBe("Metric preview");
  });

  it("falls back to a generic preview for an unknown definition", () => {
    const { getByRole } = render(
      <WidgetThumbnail name="a-widget-from-a-later-release" label="Future" />,
    );
    // A definition this release does not draw must still render a card, not crash it.
    expect(getByRole("img")).toBeTruthy();
    expect(hasWidgetThumbnail("a-widget-from-a-later-release")).toBe(false);
  });

  it("falls back when a definition names no preview at all", () => {
    const { getByRole } = render(
      <WidgetThumbnail name={undefined} label="Unnamed" />,
    );
    expect(getByRole("img")).toBeTruthy();
  });

  it("draws previews that differ between Widgets", () => {
    const metric = render(<WidgetThumbnail name="metric" label="Metric" />)
      .container.innerHTML;
    const table = render(<WidgetThumbnail name="table" label="Table" />)
      .container.innerHTML;
    expect(metric).not.toBe(table);
  });
});
