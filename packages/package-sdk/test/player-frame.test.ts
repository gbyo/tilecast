import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildExternalPluginFrame,
  EXTERNAL_PLUGIN_BUNDLE_PLACEHOLDER,
  EXTERNAL_PLUGIN_FRAME_POLICY,
} from "../src/player-frame";

describe("external surface frame", () => {
  it("shares exact assembly bytes with the generated Go template", () => {
    const generated = readFileSync(
      new URL(
        "../../../apps/server/internal/extensions/sandbox/plugin_frame.gen.go",
        import.meta.url,
      ),
      "utf8",
    );
    const literal = generated.split("const PluginTemplate = ")[1]?.trim();
    expect(JSON.parse(literal!)).toBe(
      buildExternalPluginFrame(EXTERNAL_PLUGIN_BUNDLE_PLACEHOLDER),
    );
  });
  it("escapes inline script closers without adding a second executable context", () => {
    const document = buildExternalPluginFrame(
      `var sample = "</ScRiPt><img src=https://example.org>";`,
    );
    expect(document).toContain(`<\\/script><img`);
    expect(document.match(/<\/script>/g)).toHaveLength(2);
    expect(document).toContain(`event.source !== window.parent`);
    expect(document).toContain(`message.helloToken !== token`);
  });
  it("denies all subresource and network sources at the response boundary", () => {
    for (const directive of [
      "default-src",
      "img-src",
      "media-src",
      "font-src",
      "connect-src",
      "worker-src",
      "object-src",
      "base-uri",
      "form-action",
    ]) {
      expect(EXTERNAL_PLUGIN_FRAME_POLICY).toContain(`${directive} 'none'`);
    }
    for (const permission of [
      "allow-same-origin",
      "allow-forms",
      "allow-top-navigation",
      "allow-popups",
    ]) {
      expect(EXTERNAL_PLUGIN_FRAME_POLICY).not.toContain(permission);
    }
  });
});
