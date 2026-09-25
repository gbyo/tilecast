import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// Generated OpenAPI reference pages have no source Markdown file, so the
// Copy page and View as Markdown actions would link to files that do not
// exist. Hide both actions there with the page-action plugin's documented
// per-page opt-out. Handwritten pages keep the actions.
export const onRequest = defineRouteMiddleware((context) => {
  const { starlightRoute } = context.locals;
  if (!starlightRoute || !starlightRoute.entry?.data) return;

  // Keep the development status visible on every current and future Edge page
  // without duplicating the same frontmatter across the whole section.
  if (starlightRoute.id === "edge" || starlightRoute.id.startsWith("edge/")) {
    starlightRoute.entry.data.banner = {
      content: "Tilecast Edge is in preview and is not the production Linux Player yet.",
    };
  }

  if (context.url.pathname.includes("/reference/api/endpoints")) {
    starlightRoute.entry.data.pageContextActions = false;
  }
});
