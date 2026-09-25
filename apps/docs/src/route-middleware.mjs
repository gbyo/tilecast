import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// Apply docs-wide route metadata that is easier to keep centralized than to
// repeat in page frontmatter. Generated OpenAPI reference pages have no source
// Markdown file, so their page actions are hidden below.
export const onRequest = defineRouteMiddleware((context) => {
  const { starlightRoute } = context.locals;
  if (!starlightRoute || !starlightRoute.entry?.data) return;

  // Keep the development status visible on every current and future Edge page
  // without duplicating the same frontmatter across the whole section.
  if (starlightRoute.id === "edge" || starlightRoute.id.startsWith("edge/")) {
    starlightRoute.entry.data.banner = {
      content:
        "Tilecast Edge is in preview and is not the production Linux Player yet.",
    };
  }

  if (context.url.pathname.includes("/reference/api/endpoints")) {
    starlightRoute.entry.data.pageContextActions = false;
  }
});
