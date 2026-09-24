// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightPageContextAction from "starlight-page-context-action";
import starlightOpenAPIPlugin, {
  createOpenAPISidebarGroup,
} from "starlight-openapi";

const repository = "https://github.com/gbyo/tilecast";

// The shared design tokens select their dark values with `html.dark`, the
// class Tilecast Studio sets. Starlight records the theme in `data-theme`
// instead, so mirror it onto the class before first paint. Starlight's theme
// script runs after this one, and the observer also follows the theme picker.
const syncTokenTheme = `(() => {
  const root = document.documentElement;
  const sync = () => root.classList.toggle("dark", root.dataset.theme === "dark");
  sync();
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
})();`;

// Local Starlight plugin. Generated reference pages have no source file, so
// the per-page Markdown actions are hidden there (see route-middleware.mjs).
// It uses only the public addRouteMiddleware hook.
/** @returns {import("@astrojs/starlight/types").StarlightPlugin} */
function tilecastDocsPlugin() {
  return {
    name: "tilecast-docs",
    hooks: {
      "config:setup"({ addRouteMiddleware }) {
        addRouteMiddleware({
          entrypoint: new URL("./src/route-middleware.mjs", import.meta.url)
            .pathname,
          order: "pre",
        });
      },
    },
  };
}

export default defineConfig({
  site: "https://gbyo.github.io",
  base: "/tilecast",
  // GitHub Pages serves each page as a directory index and redirects a path
  // without a slash. Match that locally so relative content links resolve
  // the same way in development and in production.
  trailingSlash: "always",
  vite: {
    // Astro's prerender entry imports `cookie` by bare name from `dist/`.
    // In this npm workspace that name resolves to the root `cookie@0` that
    // another workspace needs, not Astro's own `cookie@2`. Bundling it keeps
    // Astro's version.
    resolve: { noExternal: ["cookie"] },
  },
  integrations: [
    starlight({
      title: "Tilecast Docs",
      description:
        "Install Tilecast, connect Tilecast Player to your displays, and publish content from Tilecast Studio.",
      plugins: [
        tilecastDocsPlugin(),
        // Generates llms.txt, llms-full.txt, and llms-small.txt from the
        // public docs collection. Draft pages are excluded automatically.
        // Engineering documents outside apps/docs are never included.
        starlightLlmsTxt({
          projectName: "Tilecast",
          // Content collection IDs include the file extension.
          exclude: ["404.md"],
          optionalLinks: [
            {
              label: "Tilecast repository",
              url: "https://github.com/gbyo/tilecast",
              description:
                "Source code, releases, and engineering references for Tilecast.",
            },
          ],
        }),
        // Generates endpoint reference pages from the canonical OpenAPI
        // description. docs/openapi.yaml stays the single source of truth;
        // no copy is maintained inside apps/docs.
        starlightOpenAPIPlugin([
          {
            base: "reference/api/endpoints",
            schema: "../../docs/openapi.yaml",
            sidebar: {
              label: "Endpoints",
              collapsed: true,
              operations: { badges: true, labels: "summary" },
            },
          },
        ]),
        // Adds Copy page and View as Markdown actions above the table of
        // contents. AI chat and scroll actions stay off: the docs send
        // nothing to third-party services.
        starlightPageContextAction({
          actions: {
            copy: true,
            viewMarkdown: true,
            chatgpt: false,
            claude: false,
            t3chat: false,
            scrollTop: false,
          },
        }),
      ],
      logo: {
        light: "../../.github/logos/tilecast-logo-black.svg",
        dark: "../../.github/logos/tilecast-logo-white.svg",
        // The wordmark replaces the visible title. The title stays available
        // to screen readers, so the image itself needs no alt text.
        alt: "",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repository }],
      editLink: {
        baseUrl: `${repository}/edit/main/apps/docs/`,
      },
      lastUpdated: true,
      // English is canonical and lives at the site root. Spanish and Russian
      // are not exposed until translated pages exist. See README.md.
      locales: {
        root: { label: "English", lang: "en" },
      },
      customCss: [
        "@fontsource-variable/geist",
        "@tilecast/design-tokens/tokens.css",
        "./src/styles/tilecast.css",
      ],
      expressiveCode: {
        styleOverrides: { borderRadius: "var(--tc-radius-panel)" },
      },
      head: [{ tag: "script", content: syncTokenTheme }],
      // Each group and its page order are an editorial decision: the sidebar
      // follows the reader's task flow, not the content directory layout or
      // Studio's own navigation. A sidebar badge must communicate something
      // that affects the reader, such as a platform or coverage limit.
      sidebar: [
        { label: "Home", slug: "index" },
        {
          label: "Set up",
          items: [{ slug: "getting-started" }, { slug: "installation" }],
        },
        {
          label: "Studio content",
          items: [
            { slug: "studio" },
            { slug: "media" },
            { slug: "data-sources" },
            { slug: "widgets" },
            { slug: "playlists" },
            { slug: "layouts" },
            { slug: "schedules" },
            { slug: "campaigns" },
          ],
        },
        {
          label: "Players and screens",
          items: [
            { slug: "players" },
            { slug: "players/install-android" },
            { slug: "players/install-linux" },
            { slug: "players/pair-a-display" },
            { slug: "players/update-a-player" },
            { slug: "screens/pair-and-replace" },
            { slug: "screens/display-groups" },
          ],
        },
        {
          label: "Operations",
          items: [
            { slug: "operations" },
            { slug: "operations/activity" },
            { slug: "operations/screen-status" },
            { slug: "operations/takeover" },
            { slug: "operations/player-commands" },
            { slug: "operations/plugins" },
            {
              slug: "operations/emergency-alerts",
              badge: { text: "US", variant: "note" },
            },
          ],
        },
        {
          label: "Administration",
          items: [
            { slug: "administration" },
            { slug: "administration/users-and-roles" },
            { slug: "administration/sign-in-security" },
            { slug: "administration/player-policies" },
            { slug: "administration/backups" },
            { slug: "administration/player-updates" },
          ],
        },
        {
          label: "Integrate and build",
          items: [
            { slug: "integrations" },
            { slug: "integrations/tokens" },
            { slug: "integrations/manual-table" },
            { slug: "integrations/fleet-health" },
            { slug: "integrations/notifications" },
            { slug: "developers" },
            { slug: "reference" },
            { slug: "reference/api" },
            // Generated endpoint reference from docs/openapi.yaml. The
            // handwritten API overview stays the starting point; these
            // pages own endpoint-by-endpoint details.
            createOpenAPISidebarGroup(),
          ],
        },
      ],
    }),
  ],
});
