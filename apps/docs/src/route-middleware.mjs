import { spawnSync } from "node:child_process";
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

/**
 * The newest commit date of a file relative to the docs site root, which is
 * the working directory of `astro build` and `astro dev`. Undefined outside a
 * git checkout.
 */
function newestCommitDate(filePath) {
  const result = spawnSync(
    "git",
    ["log", "--format=%ct", "--max-count=1", "--", filePath],
    { cwd: process.cwd(), encoding: "utf-8" },
  );
  const seconds = Number.parseInt(result.stdout?.trim() ?? "", 10);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined;
}

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
  // entry path, so give them the path the page would have here, and
  // plugin-docs.mjs publishes the copy. The edit link was already taken
  // from the real file.
  if (starlightRoute.entry.filePath?.startsWith("../../plugins/")) {
    // Starlight reads last-updated dates for src/content/docs only.
    starlightRoute.lastUpdated ??= newestCommitDate(
      starlightRoute.entry.filePath,
    );
    starlightRoute.entry.filePath = `src/content/docs/${starlightRoute.id}.mdx`;
  }

  if (context.url.pathname.includes("/reference/api/endpoints")) {
    starlightRoute.entry.data.pageContextActions = false;
  }
});
