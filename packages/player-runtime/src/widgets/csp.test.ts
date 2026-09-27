/*
 * Widgets V2 depend on the runtime CSP staying strict (docs/widgets-v2.md
 * §9): Widgets style themselves with adopted stylesheets and the CSSOM,
 * never with inline styles. This test fails if anyone loosens the policy to
 * make a Widget work. The conformance fixture `widget-component` proves the
 * engines enforce it.
 */
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import html from "../../static/index.html?raw";

const policy =
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ??
  "";
const directives = new Map(
  policy
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...values] = part.split(/\s+/);
      return [name!, values] as const;
    }),
);

describe("runtime CSP", () => {
  it("keeps style and script sources to the runtime itself", () => {
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("style-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
  });

  it("allows no inline code, eval or nonce-based escape hatch", () => {
    expect(policy).not.toMatch(
      /unsafe-inline|unsafe-eval|unsafe-hashes|nonce-|sha256-|strict-dynamic/,
    );
    expect(directives.has("style-src-attr")).toBe(false);
    expect(directives.has("style-src-elem")).toBe(false);
  });

  it("gives Widgets no network destinations", () => {
    expect(directives.has("connect-src")).toBe(false);
    expect(directives.get("img-src")).toEqual(["'self'", "tcmedia:", "data:"]);
  });
});
