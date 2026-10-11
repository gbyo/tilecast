import { expect, test } from "@playwright/test";

async function open(
  page: import("@playwright/test").Page,
  story = "fullscreen",
  reducedMotion: "reduce" | "no-preference" = "no-preference",
) {
  await page.emulateMedia({ reducedMotion });
  await page.goto(
    `/iframe.html?id=widgets-event-scroller--${story}&viewMode=story`,
  );
  await expect(page.locator("tc-widget-event-scroller .board")).toBeVisible();
}

test("Auto and forced flows follow the container, with progressive secondary fields", async ({
  page,
}) => {
  await open(page, "custom-theme");
  const widget = page.locator("tc-widget-event-scroller");
  await expect(widget.locator(".track")).toHaveCSS("flex-direction", "column");
  await expect(widget.locator(".location").first()).toBeVisible();
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(".tc-story-frame")!;
    frame.style.width = "600px";
    frame.style.height = "800px";
  });
  await expect(widget.locator(".location").first()).toBeHidden();
  await expect(widget.locator(".category").first()).toBeHidden();
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(".tc-story-frame")!;
    frame.style.width = "1920px";
    frame.style.height = "200px";
  });
  await expect(widget.locator(".track")).toHaveCSS("flex-direction", "row");
  await open(page, "forced-vertical");
  await expect(widget.locator(".track")).toHaveCSS("flex-direction", "column");
  await open(page, "forced-horizontal");
  await expect(widget.locator(".track")).toHaveCSS("flex-direction", "row");
});

for (const story of [
  "fullscreen",
  "few-events",
  "many-events",
  "auto-rail",
  "horizontal",
  "larger-text",
  "tight-rows",
  "natural-spacing",
  "large-rail",
]) {
  test(`${story}: two viewport-sized groups and a seamless transform loop`, async ({
    page,
  }) => {
    await open(page, story);
    const geometry = await page.evaluate(() => {
      const root = document.querySelector(
        "tc-widget-event-scroller",
      )!.shadowRoot!;
      const track = root.querySelector<HTMLElement>(".track")!;
      const groups = root.querySelectorAll<HTMLElement>(".group");
      const viewport = root.querySelector<HTMLElement>(".viewport")!;
      const horizontal = getComputedStyle(track).flexDirection === "row";
      const axis = horizontal ? "width" : "height";
      const animation = track.getAnimations()[0]!;
      animation.pause();
      animation.currentTime = 0;
      const start = new DOMMatrix(getComputedStyle(track).transform);
      const duration = Number(animation.effect!.getTiming().duration);
      animation.currentTime = duration - 0.001;
      const end = new DOMMatrix(getComputedStyle(track).transform);
      return {
        groups: groups.length,
        groupA: groups[0]!.getBoundingClientRect()[axis],
        groupB: groups[1]!.getBoundingClientRect()[axis],
        viewport: viewport.getBoundingClientRect()[axis],
        track: track.getBoundingClientRect()[axis],
        distance: horizontal ? start.m41 - end.m41 : start.m42 - end.m42,
        direction: getComputedStyle(track).animationDirection,
      };
    });
    expect(geometry.groups).toBe(2);
    expect(geometry.groupA).toBeGreaterThanOrEqual(geometry.viewport - 1);
    expect(geometry.groupA).toBeCloseTo(geometry.groupB, 1);
    expect(geometry.track).toBeCloseTo(geometry.groupA * 2, 1);
    expect(geometry.distance).toBeCloseTo(geometry.groupA, 1);
    expect(geometry.direction).toBe("normal");
  });
}

test("reverse directions, reduced motion, and CSS motion safety", async ({
  page,
}) => {
  await open(page, "down");
  await expect(page.locator("tc-widget-event-scroller .track")).toHaveCSS(
    "animation-direction",
    "reverse",
  );
  await open(page, "right");
  await expect(page.locator("tc-widget-event-scroller .track")).toHaveCSS(
    "animation-direction",
    "reverse",
  );
  await open(page, "reduced-motion");
  await expect(page.locator("tc-widget-event-scroller .group")).toHaveCount(1);
  await expect(page.locator("tc-widget-event-scroller .track")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(page.locator("tc-widget-event-scroller .track")).toHaveCSS(
    "transform",
    "none",
  );
  await open(page, "fullscreen", "reduce");
  await expect(
    page.locator("tc-widget-event-scroller .group[aria-hidden='true']"),
  ).toBeHidden();
  await expect(page.locator("tc-widget-event-scroller .track")).toHaveCSS(
    "transform",
    "none",
  );
});

test("titles truncate without changing the single-line row geometry", async ({
  page,
}) => {
  await open(page, "long-title");
  const rows = await page
    .locator("tc-widget-event-scroller .group[role='list'] .row")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const title = node.querySelector<HTMLElement>(".title")!;
        return {
          height: node.getBoundingClientRect().height,
          nowrap: getComputedStyle(title).whiteSpace,
          clipped: title.scrollWidth > title.clientWidth,
        };
      }),
    );
  expect(rows.every((row) => row.nowrap === "nowrap" && row.clipped)).toBe(
    true,
  );
  expect(new Set(rows.map((row) => Math.round(row.height))).size).toBe(1);
});

async function sizing(page: import("@playwright/test").Page) {
  return page.locator("tc-widget-event-scroller").evaluate((widget) => {
    const root = widget.shadowRoot!;
    const row = root.querySelector<HTMLElement>(".row")!;
    const heading = root.querySelector<HTMLElement>(".heading")!;
    const board = root.querySelector<HTMLElement>(".board")!;
    const rowStyle = getComputedStyle(row);
    const headingStyle = getComputedStyle(heading);
    return {
      text: parseFloat(rowStyle.fontSize),
      heading: parseFloat(headingStyle.fontSize),
      rowHeight: row.getBoundingClientRect().height,
      rowPadding: parseFloat(rowStyle.paddingTop),
      rowBorder: parseFloat(rowStyle.borderBottomWidth),
      outerPadding: parseFloat(getComputedStyle(board).paddingTop),
      headingMargin: parseFloat(headingStyle.marginBottom),
      headingPadding: parseFloat(headingStyle.paddingBottom),
    };
  });
}

test("event and heading text grow independently of responsive automatic sizing", async ({
  page,
}) => {
  await open(page);
  const standard = await sizing(page);
  await open(page, "larger-text");
  const larger = await sizing(page);
  // A taller heading reduces the inner viewport; typography remains container-relative.
  expect(larger.text).toBeGreaterThan(standard.text * 1.5);
  expect(larger.heading / standard.heading).toBeCloseTo(1.2, 1);
  await page.locator("tc-widget-event-scroller").evaluate(async (node) => {
    const widget = node as HTMLElement & {
      config: Record<string, unknown>;
      updateComplete: Promise<unknown>;
    };
    widget.config = { ...widget.config, textScale: 100 };
    await widget.updateComplete;
  });
  const changed = await sizing(page);
  expect(larger.text / changed.text).toBeCloseTo(1.6, 1);
  expect(changed.heading).toBeCloseTo(larger.heading, 1);
});

test("natural rows honor spacing and zero padding without viewport stretching", async ({
  page,
}) => {
  await open(page);
  const standard = await sizing(page);
  await open(page, "tight-rows");
  const tight = await sizing(page);
  expect(tight.text).toBeGreaterThan(standard.text);
  expect(tight.rowHeight).toBeLessThan(standard.rowHeight);
  expect(tight.rowPadding / tight.text).toBeCloseTo(0.05, 2);
  expect(tight.rowHeight).toBeCloseTo(tight.text * 1.3 + tight.rowBorder, 0);
  expect(tight.outerPadding).toBeLessThan(standard.outerPadding);
  expect(tight.headingMargin).toBeLessThan(standard.headingMargin);
  await page.locator("tc-widget-event-scroller").evaluate(async (node) => {
    const widget = node as HTMLElement & {
      config: Record<string, unknown>;
      updateComplete: Promise<unknown>;
    };
    widget.config = {
      ...widget.config,
      rowSpacing: 0,
      contentPadding: 0,
      headingSpacing: 0,
    };
    await widget.updateComplete;
  });
  const zero = await sizing(page);
  expect(zero.rowPadding).toBe(0);
  expect(zero.outerPadding).toBe(0);
  expect(zero.headingMargin).toBe(0);
  expect(zero.headingPadding).toBe(0);
  expect(zero.rowHeight).toBeCloseTo(zero.text * 1.2 + zero.rowBorder, 0);
});

test("maximum text and row spacing grow rows without clipping or overlapping text", async ({
  page,
}) => {
  await open(page, "larger-text");
  await page.locator("tc-widget-event-scroller").evaluate(async (node) => {
    const widget = node as HTMLElement & {
      config: Record<string, unknown>;
      updateComplete: Promise<unknown>;
    };
    widget.config = {
      ...widget.config,
      textScale: 300,
      rowSpacing: 200,
      density: "compact",
    };
    await widget.updateComplete;
  });
  const large = await sizing(page);
  expect(large.rowHeight).toBeGreaterThanOrEqual(
    large.text * 3.2 + large.rowBorder - 1,
  );
  const rows = await page
    .locator("tc-widget-event-scroller .group[role='list'] .row")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        top: node.getBoundingClientRect().top,
        bottom: node.getBoundingClientRect().bottom,
        clipped: node.scrollHeight > node.clientHeight + 1,
      })),
    );
  expect(rows.every((row) => !row.clipped)).toBe(true);
  expect(
    rows.slice(1).every((row, index) => row.top >= rows[index]!.bottom - 1),
  ).toBe(true);
});
