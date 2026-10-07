// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightPageContextAction from "starlight-page-context-action";
import starlightOpenAPIPlugin from "starlight-openapi";
import { pluginPageMarkdown } from "./plugin-docs.mjs";
import { redirects } from "./redirects.mjs";

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
      "config:setup"({ addRouteMiddleware, addIntegration }) {
        addIntegration(pluginPageMarkdown());
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
  site: "https://tilecast.org",
  // GitHub Pages serves each page as a directory index and redirects a path
  // without a slash. Match that locally so relative content links resolve
  // the same way in development and in production.
  trailingSlash: "always",
  // Compatibility aliases for retired public paths. See redirects.mjs.
  redirects,
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
        // no copy is maintained inside apps/docs. No `sidebar.group` is
        // set, on purpose: the pages exist at /reference/api/endpoints/ but
        // do not add their 380 or so routes to the global sidebar. The
        // Reference group links to the overview page, which lists them.
        starlightOpenAPIPlugin([
          {
            base: "reference/api/endpoints",
            schema: "../../docs/openapi.yaml",
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
      favicon: "/favicon.png",
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
      head: [
        { tag: "link", attrs: { rel: "sitemap", href: "/sitemap-index.xml" } },
        { tag: "script", content: syncTokenTheme },
        {
          tag: "script",
          attrs: { type: "text/javascript" },
          content: `(function(c,l,a,r,i,t,y){
    c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
    t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
    y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
})(window, document, "clarity", "script", "ysr2mieho2");`,
        },
      ],
      // The sidebar is a curated task map, not a table of contents. Each
      // group lists a section hub first, then a few direct links. Deeper
      // pages stay published and searchable, and their hub pages link them.
      // See README.md before you add an entry.
      sidebar: [
        { label: "Home", slug: "index" },
        {
          label: "Start here",
          collapsed: true,
          items: [
            { slug: "getting-started" },
            { label: "Find the right setup", slug: "setup" },
            { label: "Install Tilecast", slug: "installation" },
            { slug: "setup/choose-a-server" },
            { slug: "setup/network-readiness" },
            {
              label: "Production checklist",
              slug: "setup/production-readiness",
            },
          ],
        },
        {
          label: "Create & publish",
          collapsed: true,
          items: [
            { label: "Overview", slug: "studio" },
            { label: "Media & websites", slug: "studio/media-and-websites" },
            { label: "Widgets & data", slug: "studio/widgets-and-data" },
            { label: "Playlists", slug: "playlists" },
            { label: "Layouts", slug: "layouts" },
            { label: "Schedules", slug: "schedules" },
            { label: "Campaigns", slug: "campaigns" },
            { label: "Review & forms", slug: "studio/review-and-forms" },
          ],
        },
        {
          label: "Screens & players",
          collapsed: true,
          items: [
            { label: "Overview", slug: "players" },
            { label: "Install and pair", slug: "players/install-and-pair" },
            { label: "Groups & walls", slug: "screens/groups-and-walls" },
            { label: "Playback behavior", slug: "screens/explain-playback" },
            {
              label: "Reliability, power & accessibility",
              slug: "players/reliability-power-accessibility",
            },
            { label: "Display control", slug: "screens/display-control" },
            { label: "Player updates", slug: "players/update-a-player" },
            {
              label: "Tilecast Edge",
              slug: "edge",
              badge: { text: "Preview", variant: "caution" },
            },
          ],
        },
        {
          label: "Manage Tilecast",
          collapsed: true,
          items: [
            { label: "Overview", slug: "manage" },
            { label: "Fleet health & Activity", slug: "operations/activity" },
            { label: "Live preview", slug: "operations/live-preview" },
            {
              label: "Temporary presentations",
              slug: "operations/temporary-presentations",
            },
            { label: "Users & access", slug: "administration/users-and-roles" },
            {
              label: "Organization settings",
              slug: "administration/organization",
            },
            {
              label: "Networking & remote access",
              slug: "administration/networking",
            },
            {
              label: "Backups & server updates",
              slug: "administration/backups",
            },
            { label: "Data & retention", slug: "operations/data-retention" },
          ],
        },
        {
          label: "Automate & extend",
          collapsed: true,
          items: [
            { label: "Overview", slug: "integrations" },
            { label: "CLI", slug: "integrations/cli" },
            { label: "MCP", slug: "integrations/mcp" },
            {
              label: "API access & tokens",
              slug: "integrations/personal-access-tokens",
            },
            {
              label: "Connect other systems",
              slug: "integrations/connect-other-systems",
            },
            // Each plugin's own guide is linked from this page, so a plugin
            // needs no entry here. See the plugin test in plugin-docs.test.mjs.
            { label: "Plugins", slug: "operations/plugins" },
            { label: "Marketplace", slug: "operations/marketplace" },
          ],
        },
        { slug: "troubleshooting" },
        {
          label: "Developers",
          collapsed: true,
          items: [
            { label: "Overview", slug: "developers" },
            { label: "Development setup", slug: "developers/setup" },
            { label: "Architecture", slug: "developers/architecture" },
            { label: "Testing & CI", slug: "developers/testing" },
            {
              label: "Player development",
              slug: "developers/player-development",
            },
            { label: "Plugin development", slug: "developers/plugins" },
            { label: "iOS development", slug: "developers/ios-app" },
          ],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { label: "Overview", slug: "reference" },
            { label: "HTTP API", slug: "reference/api" },
            // The endpoint pages are generated by starlight-openapi below.
            // The plugin builds them without a sidebar group, so this link
            // is the one entry point. The overview page lists every route.
            { label: "API endpoints", link: "/reference/api/endpoints/" },
            {
              label: "Content definitions",
              slug: "reference/content-definitions",
            },
            { label: "Capability reference", slug: "players/capabilities" },
          ],
        },
        { slug: "privacy" },
      ],
    }),
  ],
});
