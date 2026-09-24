// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

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
      // Each top-level section is listed explicitly so its order is an
      // editorial decision. When a section gains pages, turn its entry into
      // a group. High-volume reference areas can then use `autogenerate`.
      sidebar: [
        { label: "Home", slug: "index" },
        { slug: "getting-started" },
        { slug: "installation" },
        { slug: "studio" },
        { slug: "players" },
        { slug: "administration" },
        { slug: "operations" },
        { slug: "integrations" },
        { slug: "developers" },
        { slug: "reference" },
      ],
    }),
  ],
});
