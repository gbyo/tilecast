// @ts-check
// Permanent compatibility aliases for public documentation URLs that no longer
// have a page. Keys are the old paths and values are the canonical paths, both
// absolute from the site root and ending in a slash. Astro reads this object
// as its `redirects` setting.
//
// The site is static and adapterless, so each entry builds as an HTML page
// with a meta refresh, not as an HTTP 301. Search engines and browsers follow
// it, but a server never sends the status code.
//
// Add an entry only when a public page genuinely moves or is retired. Keep it
// indefinitely, because readers bookmark and link to these paths. Point it
// straight at the final page: no chains, no loops. `scripts/check-redirects.mjs`
// enforces these rules during `npm run docs:check` and `npm run docs:build`.

/** @type {Record<string, string>} */
export const redirects = {
  // Operations and Administration were two section indexes. Manage Tilecast
  // replaced both. The pages below them keep their URLs.
  "/operations/": "/manage/",
  "/administration/": "/manage/",
};
