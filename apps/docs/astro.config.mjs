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
  site: "https://tilecast.org",
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
      // Keep the top-level order task-first and arrange each section around
      // the reader's work rather than the filesystem or Studio's own menu.
      sidebar: [
        { label: "Home", slug: "index" },
        { slug: "getting-started" },
        { slug: "installation" },
        {
          label: "Tilecast Studio",
          collapsed: true,
          items: [
            { label: "Overview", slug: "studio" },
            {
              label: "Create content",
              collapsed: true,
              items: [
                { slug: "media" },
                { slug: "website-content" },
                { slug: "data-sources" },
                { slug: "widgets" },
              ],
            },
            {
              label: "Build presentations",
              collapsed: true,
              items: [
                { slug: "playlists" },
                { slug: "layouts" },
                { slug: "campaigns" },
                { slug: "schedules" },
              ],
            },
            {
              label: "Review and collect",
              collapsed: true,
              items: [
                { slug: "studio/content-review" },
                { slug: "studio/content-submissions" },
                { slug: "studio/forms" },
                { slug: "studio/forms-approvals" },
              ],
            },
          ],
        },
        {
          label: "Players",
          collapsed: true,
          items: [
            { slug: "players" },
            {
              label: "Install and connect",
              collapsed: true,
              items: [
                { slug: "players/install-android" },
                { slug: "players/install-linux" },
                { slug: "players/pair-a-display" },
                { slug: "screens/pair-and-replace" },
              ],
            },
            {
              label: "Manage screens",
              collapsed: true,
              items: [
                { slug: "screens/archive" },
                { slug: "screens/bulk-changes" },
              ],
            },
            {
              label: "Groups and walls",
              collapsed: true,
              items: [
                { slug: "screens/display-groups" },
                { slug: "screens/span-video-walls" },
              ],
            },
            {
              label: "Reliability and behavior",
              collapsed: true,
              items: [
                { slug: "players/reliability-kiosk" },
                { slug: "players/active-hours-power" },
                { slug: "players/accessibility" },
              ],
            },
            { slug: "players/update-a-player" },
            { slug: "players/capabilities" },
          ],
        },
        {
          label: "Tilecast Edge",
          badge: { text: "Preview", variant: "caution" },
          collapsed: true,
          items: [
            { label: "Overview", slug: "edge" },
            {
              label: "Get Edge running",
              collapsed: true,
              items: [
                { slug: "edge/requirements" },
                { slug: "edge/install" },
                { slug: "edge/migrate" },
                { slug: "edge/pairing" },
              ],
            },
            {
              label: "Operate Edge",
              collapsed: true,
              items: [
                { slug: "edge/compatibility" },
                { slug: "edge/updates" },
                { slug: "edge/offline-resilience" },
                { slug: "edge/hardware" },
                { slug: "edge/monitoring" },
                { slug: "edge/troubleshooting" },
              ],
            },
            {
              label: "Understand Edge",
              collapsed: true,
              items: [{ slug: "edge/security" }, { slug: "edge/capabilities" }],
            },
          ],
        },
        {
          label: "Administration",
          collapsed: true,
          items: [
            { slug: "administration" },
            {
              label: "Organization",
              collapsed: true,
              items: [
                { slug: "administration/organization" },
                { slug: "administration/language-regional" },
                { slug: "administration/branding" },
                { slug: "administration/locations" },
              ],
            },
            {
              label: "Accounts and access",
              collapsed: true,
              items: [
                { slug: "administration/users-and-roles" },
                { slug: "administration/sign-in-security" },
                { slug: "administration/account" },
              ],
            },
            {
              label: "Player and installation",
              collapsed: true,
              items: [
                { slug: "administration/player-policies" },
                { slug: "administration/content-settings" },
                { slug: "administration/networking" },
                { slug: "administration/server-updates" },
                { slug: "administration/presentation-networks" },
                { slug: "administration/player-updates" },
                { slug: "administration/backups" },
              ],
            },
            {
              label: "System and data",
              collapsed: true,
              items: [
                { slug: "operations/data-retention" },
                { slug: "operations/snapshot-history" },
                { slug: "administration/system" },
                { slug: "administration/import-export" },
                { slug: "administration/dependency-graph" },
              ],
            },
          ],
        },
        {
          label: "Operations",
          collapsed: true,
          items: [
            { slug: "operations" },
            {
              label: "Monitor screens",
              collapsed: true,
              items: [
                { slug: "operations/activity" },
                { slug: "operations/screen-status" },
                { slug: "operations/live-preview" },
              ],
            },
            {
              label: "Temporary presentations",
              collapsed: true,
              items: [
                { slug: "operations/quick-present" },
                { slug: "operations/airplay-present" },
                { slug: "operations/takeover" },
              ],
            },
            {
              label: "Device actions",
              collapsed: true,
              items: [
                { slug: "screens/display-control" },
                { slug: "operations/player-commands" },
              ],
            },
            {
              label: "Plugins and alerts",
              collapsed: true,
              items: [
                { slug: "operations/plugins" },
                { slug: "operations/plugins/countdown-bar" },
                { slug: "operations/plugins/brand-bug" },
                { slug: "operations/plugins/noise-meter" },
                {
                  slug: "operations/emergency-alerts",
                  badge: { text: "US", variant: "note" },
                },
              ],
            },
          ],
        },
        {
          label: "Troubleshooting",
          collapsed: true,
          items: [
            { slug: "troubleshooting" },
            { slug: "troubleshooting/server" },
            { slug: "troubleshooting/pairing-connectivity" },
            { slug: "troubleshooting/playback" },
            { slug: "troubleshooting/media" },
            { slug: "troubleshooting/websites" },
            { slug: "troubleshooting/player-updates" },
            { slug: "troubleshooting/display-control" },
            { slug: "troubleshooting/airplay-networks" },
            { slug: "troubleshooting/sign-in" },
          ],
        },
        {
          label: "Integrations",
          collapsed: true,
          items: [
            { slug: "integrations" },
            { slug: "integrations/tokens" },
            { slug: "integrations/manual-table" },
            { slug: "integrations/fleet-health" },
            { slug: "integrations/notifications" },
          ],
        },
        {
          label: "Developers",
          collapsed: true,
          items: [{ slug: "developers" }, { slug: "developers/demo-mode" }],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { slug: "reference" },
            { slug: "reference/api" },
            { slug: "reference/content-definitions" },
            // Generated OpenAPI endpoint pages were already on main. Keep
            // them under Reference without adding or editing their content.
            createOpenAPISidebarGroup(),
          ],
        },
      ],
    }),
  ],
});
