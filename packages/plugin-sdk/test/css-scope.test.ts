import { describe, expect, it } from "vitest";
import { checkCssScope } from "../tools/pluginctl/css-scope.ts";

describe("plugin runtime stylesheet scope", () => {
  it("accepts rules inside the plugin's namespace", () => {
    const css = `
      /* comment { with braces } */
      .tc-transit-alerts { color: red; }
      .tc-transit-alerts--visible, .tc-transit-alerts__line > span { margin: 0; }
      .tc-transit-alerts[data-state="late"] .tc-transit-alerts__time:empty { display: none; }
      @keyframes tc-transit-alerts-scroll { from { opacity: 0; } to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .tc-transit-alerts__line { animation: none; }
      }
    `;
    expect(checkCssScope(css, "transit-alerts")).toEqual([]);
  });

  it.each([
    ["an id", "#content-stage { bottom: 0; }"],
    ["a bare element", "img { display: none; }"],
    ["another plugin's class", ".tc-countdown-bar { color: red; }"],
    [
      "a longer name with the same prefix",
      ".tc-transit-alerts-extra { color: red; }",
    ],
    ["the document root", ":root { --x: 1; }"],
    ["a later selector in a list", ".tc-transit-alerts, body { margin: 0; }"],
    ["a rule inside @media", "@media print { .layer { display: none; } }"],
    [
      "an unprefixed keyframes name",
      "@keyframes scroll { from { opacity: 0; } }",
    ],
    ["@import", '@import url("x.css");'],
    ["@font-face", "@font-face { font-family: x; }"],
  ])("refuses %s", (_name, css) => {
    expect(checkCssScope(css, "transit-alerts").length).toBeGreaterThan(0);
  });
});
