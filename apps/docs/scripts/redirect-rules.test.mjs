import assert from "node:assert/strict";
import { test } from "node:test";
import { redirects } from "../redirects.mjs";
import {
  generatedRoutePrefixes,
  linksInSource,
  resolveInternal,
  sourcePages,
} from "./docs-routes.mjs";
import { aliasLinkProblems, registryProblems } from "./redirect-rules.mjs";

const site = { routes: ["/manage/", "/players/", "/operations/activity/"] };
const problems = (map, extra = {}) =>
  registryProblems(map, { ...site, ...extra });

test("accepts a redirect to a real page", () => {
  assert.deepEqual(problems({ "/operations/": "/manage/" }), []);
});

test("rejects a redirect to itself", () => {
  assert.match(problems({ "/manage/": "/manage/" })[0], /points to itself/);
});

test("rejects a loop", () => {
  const found = problems({ "/a/": "/b/", "/b/": "/a/" }).join("\n");
  assert.match(found, /redirect loop/);
});

test("rejects a chain and names the final page", () => {
  const found = problems({
    "/old/": "/older/",
    "/older/": "/manage/",
  }).join("\n");
  assert.match(found, /redirect chain/);
  assert.match(found, /point \/old\/ at its final page/);
});

test("rejects a source that is still a real page", () => {
  assert.match(problems({ "/players/": "/manage/" })[0], /still a real page/);
});

test("rejects a destination that is not a page", () => {
  assert.match(problems({ "/old/": "/missing/" })[0], /not a page/);
});

test("accepts a destination in a generated route family", () => {
  assert.deepEqual(
    problems(
      { "/api/": "/reference/api/endpoints/operations/x/" },
      { generatedPrefixes: ["/reference/api/endpoints/"] },
    ),
    [],
  );
});

test("rejects malformed paths", () => {
  for (const bad of [
    "operations/",
    "/operations",
    "//operations/",
    "/operations/?a=1",
    "/operations/#top",
    "/a/../b/",
    "https://example.org/manage/",
    "/has space/",
  ]) {
    assert.match(
      problems({ [bad]: "/manage/" }).join("\n"),
      /internal path/,
      `source ${bad}`,
    );
    assert.match(
      problems({ "/old/": bad }).join("\n"),
      /internal path/,
      `destination ${bad}`,
    );
  }
  assert.match(problems({ "/": "/manage/" }).join("\n"), /home page/);
});

test("reports a link that goes through a redirect", () => {
  const found = aliasLinkProblems(
    [
      { where: "a.mdx:3", target: "/operations/" },
      { where: "b.mdx:4", target: "/manage/" },
    ],
    { "/operations/": "/manage/" },
  );
  assert.equal(found.length, 1);
  assert.match(found[0], /a\.mdx:3.*Link to \/manage\//);
});

test("finds links in prose, components, and frontmatter, but not in code", () => {
  const links = linksInSource(
    [
      "---",
      "hero:",
      "  actions:",
      "    - text: Go",
      "      link: getting-started/",
      "---",
      "See [one](../one/) and [two](./two/#part).",
      '<LinkCard title="Three" href="../three/" />',
      "```sh",
      "[no](../code/)",
      "```",
    ].join("\n"),
  ).map((link) => link.value);
  assert.deepEqual(links, [
    "getting-started/",
    "../one/",
    "./two/#part",
    "../three/",
  ]);
});

test("resolves relative links against the page that holds them", () => {
  assert.equal(resolveInternal("../operations/", "/studio/"), "/operations/");
  assert.equal(resolveInternal("./b/", "/a/"), "/a/b/");
  assert.equal(resolveInternal("/manage", "/a/"), "/manage/");
  assert.equal(resolveInternal("../x/#frag", "/a/b/"), "/a/x/");
  assert.equal(resolveInternal("https://example.org/x/", "/a/"), undefined);
  assert.equal(resolveInternal("#frag", "/a/"), undefined);
  assert.equal(resolveInternal("../llms.txt", "/a/"), undefined);
});

test("the real registry is valid for the real pages", () => {
  const routes = sourcePages().map((page) => page.route);
  assert.deepEqual(
    registryProblems(redirects, {
      routes,
      generatedPrefixes: generatedRoutePrefixes,
    }),
    [],
  );
});
