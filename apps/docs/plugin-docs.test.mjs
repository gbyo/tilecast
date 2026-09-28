import assert from "node:assert/strict";
import { test } from "node:test";
import { pageMarkdown, withoutHtmlComments } from "./plugin-docs.mjs";

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
