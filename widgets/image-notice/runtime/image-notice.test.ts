import { afterEach, describe, expect, it } from "vitest";
import {
  createWidgetResources,
  type WidgetResources,
} from "@tilecast/widget-sdk";
import { mountForTest } from "@tilecast/widget-sdk/testing";
import widget from "./index.ts";
import {
  parseImageNoticeConfig,
  resolveImageNoticeData,
  type ImageNoticeConfig,
} from "./image-notice.ts";

type Element = HTMLElement & { updateComplete: Promise<unknown> };

const asset = "22222222-2222-4222-8222-222222222222";
const variant = "33333333-3333-4333-8333-333333333333";
const uri = `tcmedia://variant/${asset}/${variant}`;

function granted(): WidgetResources {
  return createWidgetResources(
    { media: new Map([[`${asset}/${variant}`, uri]]) },
    { media: [{ assetId: asset, variantId: variant }] },
  );
}

const config: ImageNoticeConfig = {
  assetId: asset,
  variantId: variant,
  fit: "cover",
  caption: "Spring concert",
  background: "#000000",
  foreground: "#ffffff",
};

afterEach(() => document.body.replaceChildren());

describe("Image Notice", () => {
  it("parses the compiled configuration", () => {
    expect(
      parseImageNoticeConfig({
        image: { assetId: asset, variantId: variant },
        fit: "cover",
        caption: " Spring concert ",
        background: "#000000",
        foreground: "#ffffff",
      }),
    ).toEqual({ ok: true, config });
  });

  it.each([
    [{ image: { assetId: "../../etc/passwd", variantId: "" } }],
    [{ image: { assetId: asset, variantId: "https://example.com/x.png" } }],
    [{ fit: "tile" }],
    [{ caption: "x".repeat(201) }],
  ])("refuses %j", (value) => {
    expect(parseImageNoticeConfig(value).ok).toBe(false);
  });

  it("reads the image only through the media grant", () => {
    expect(resolveImageNoticeData(config, granted())).toEqual({
      state: "ready",
      data: { src: uri },
    });
    expect(
      resolveImageNoticeData(config, createWidgetResources({}, {})),
    ).toEqual({ state: "empty", reason: "image_unavailable" });
    expect(
      resolveImageNoticeData({ ...config, assetId: "" }, granted()),
    ).toEqual({ state: "empty", reason: "no_image" });
  });

  it("renders the image and its caption", async () => {
    const test = mountForTest(widget, {
      config: {
        image: { assetId: asset, variantId: variant },
        fit: "cover",
        caption: "Spring concert",
      },
      resources: granted(),
    });
    const element = test.element as Element;
    await element.updateComplete;
    const image = element.shadowRoot!.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(uri);
    expect(image.getAttribute("alt")).toBe("Spring concert");
    expect(image.dataset["fit"]).toBe("cover");
    expect(element.shadowRoot!.querySelector("figcaption")?.textContent).toBe(
      "Spring concert",
    );
    // The image's alternative text already announces the caption, so the
    // visible caption is hidden from assistive technology to avoid a repeat.
    expect(
      element
        .shadowRoot!.querySelector("figcaption")
        ?.parentElement?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(test.states.at(-1)).toEqual({ state: "ready" });
  });
});
