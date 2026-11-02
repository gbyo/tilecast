// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { specFromYouTube } from "@tilecast/player-runtime/projection";
import type { WidgetPresentation } from "../api/types";
import { DeclarativePresentationPreview } from "./SourceEditors";

afterEach(cleanup);

it("accepts completion only from its own YouTube frame and removes the listener on disposal", () => {
  const spec = specFromYouTube({ videoId: "M7lc1UVf-VE" }, null)!;
  if (spec.content.kind !== "youtube") throw new Error("expected YouTube");
  const onEnded = vi.fn();
  const presentation = {
    schemaVersion: 1,
    kind: "web",
    requiredCapabilities: { "web.remote": 1 },
    web: {
      mode: "remote_url",
      url: "https://www.youtube.com/embed/M7lc1UVf-VE",
      allowedHosts: ["www.youtube.com"],
      externalNetworkAccess: true,
      onlineOnly: true,
      fallbackBehavior: "placeholder",
      loadTimeoutSeconds: 30,
      lifecycle: "destroy_on_hide",
      warmSeconds: 0,
    },
  } satisfies WidgetPresentation;
  const view = render(
    <DeclarativePresentationPreview
      presentation={presentation}
      source={undefined}
      youtube={spec.content}
      onWebEnded={onEnded}
    />,
  );
  const frame = view.container.querySelector("iframe")!;
  expect(new URL(frame.src).searchParams.get("enablejsapi")).toBe("1");
  const data = JSON.stringify({ event: "onStateChange", data: 0 });
  fireEvent(
    window,
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "https://evil.example",
      data,
    }),
  );
  fireEvent(
    window,
    new MessageEvent("message", {
      source: window,
      origin: "https://www.youtube-nocookie.com",
      data,
    }),
  );
  expect(onEnded).not.toHaveBeenCalled();
  fireEvent(
    window,
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "https://www.youtube-nocookie.com",
      data,
    }),
  );
  fireEvent(
    window,
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "https://www.youtube-nocookie.com",
      data,
    }),
  );
  expect(onEnded).toHaveBeenCalledOnce();
  const source = frame.contentWindow;
  view.unmount();
  fireEvent(
    window,
    new MessageEvent("message", {
      source,
      origin: "https://www.youtube-nocookie.com",
      data,
    }),
  );
  expect(onEnded).toHaveBeenCalledOnce();
});
