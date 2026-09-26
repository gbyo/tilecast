import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// Apply docs-wide route metadata that is easier to keep centralized than to
// repeat in page frontmatter. Generated OpenAPI reference pages have no source
// Markdown file, so their page actions are hidden below.
export const onRequest = defineRouteMiddleware((context) => {
  const { starlightRoute } = context.locals;
  if (!starlightRoute || !starlightRoute.entry?.data) return;

  // Keep the qualification status visible on every current and future Edge
  // page without duplicating the same frontmatter across the whole section.
  // Remove it only when a release qualifies Edge for production hardware.
  if (starlightRoute.id === "edge" || starlightRoute.id.startsWith("edge/")) {
    starlightRoute.entry.data.banner = {
      content:
        "Tilecast Edge is in preview. Its software is complete, but it is not qualified on physical hardware yet. Use the stable Linux Player on production screens until a Tilecast release supports your hardware.",
    };
  }

  // A plugin-owned page's source is in plugins/<name>/docs/, outside this
  // app. The page actions derive their Markdown copy's address from the
  // entry path, so give them the path the page would have here; the edit
  // link and last-updated date were already taken from the real file, and
  // plugin-docs.mjs publishes the copy.
  if (starlightRoute.entry.filePath?.startsWith("../../plugins/")) {
    starlightRoute.entry.filePath = `src/content/docs/${starlightRoute.id}.mdx`;
  }

  if (context.url.pathname.includes("/reference/api/endpoints")) {
    starlightRoute.entry.data.pageContextActions = false;
  }
});
