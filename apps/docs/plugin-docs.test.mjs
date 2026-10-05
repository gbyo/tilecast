import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pageMarkdown,
  pluginDocPages,
  withoutHtmlComments,
} from "./plugin-docs.mjs";
import {
  linksInSource,
  resolveInternal,
  sourcePages,
} from "./scripts/docs-routes.mjs";

test("removes comments until none is left", () => {
  assert.equal(withoutHtmlComments("a<!-- one -->b"), "ab");
  assert.equal(withoutHtmlComments("a<!<!---->--b"), "ab");
  assert.equal(
    withoutHtmlComments("unterminated <!-- rest"),
    "unterminated  rest",
  );
  for (const input of ["<!<!---->--", "<!-<!---->--", "<!--<!---->-->"]) {
    assert.doesNotMatch(withoutHtmlComments(input), /<!--/);
  }
});

test("keeps code fences as written", () => {
  const source =
    "---\ntitle: Sample\n---\nText <!-- hidden -->\n\n```html\n<!-- shown -->\n```\n";
  assert.equal(
    pageMarkdown(source),
    "# Sample\n\nText \n\n```html\n<!-- shown -->\n```\n",
  );
});

// Plugin guides stay out of the sidebar. The plugin hub is how a reader finds
// them, so each guide a manifest declares must be linked from it.
test("every plugin guide is linked from the plugin hub", () => {
  const hub = sourcePages().find(
    (page) => page.route === "/operations/plugins/",
  );
  assert.ok(hub, "the plugin hub page exists");
  const linked = new Set(
    linksInSource(hub.text).map((link) =>
      resolveInternal(link.value, hub.route),
    ),
  );
  for (const page of pluginDocPages()) {
    assert.ok(linked.has(`/${page.id}/`), `${page.id} is linked from the hub`);
  }
});
