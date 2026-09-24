# Tilecast Docs

This workspace builds the public Tilecast documentation site with
[Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/).
The site is published to GitHub Pages at <https://gbyo.github.io/tilecast/>.

The public docs are for people who install and operate Tilecast. Engineering
specifications and contracts stay in the repository `docs/` directory.

## Commands

Run these commands from the repository root:

| Command                | Result                                                     |
| ---------------------- | ---------------------------------------------------------- |
| `npm run docs:dev`     | Starts a local server at `http://localhost:4321/tilecast/` |
| `npm run docs:check`   | Runs `astro check` for types and content frontmatter       |
| `npm run docs:build`   | Builds `apps/docs/dist` and checks every internal link     |
| `npm run docs:preview` | Serves the production build from `apps/docs/dist`          |

The build uses the Git history for the last-updated date on each page. A
shallow clone shows the wrong date. Use a full clone.

## Files

| Path                      | Contents                                                      |
| ------------------------- | ------------------------------------------------------------- |
| `astro.config.mjs`        | Site URL, base path, sidebar, theme, and Starlight settings   |
| `src/content/docs/`       | Pages. The file path is the URL path.                         |
| `src/styles/tilecast.css` | Starlight theme variables mapped to `@tilecast/design-tokens` |
| `scripts/check-links.mjs` | Post-build check for internal links and heading anchors       |
| `STYLE.md`                | Writing rules for public pages                                |

## Add a page

1. Read [`STYLE.md`](STYLE.md).
2. Add a Markdown file below `src/content/docs/`. Use `.mdx` only when the page
   uses a Starlight component.
3. Add the page to `sidebar` in `astro.config.mjs`. The sidebar is explicit. A
   page that is not in the sidebar is not in the site navigation.
4. Run `npm run docs:build`.

When a top-level section has more than one page, change its sidebar entry to a
group. A large reference section can use `autogenerate` for its directory.

## Theme

`src/styles/tilecast.css` sets the documented Starlight color, font, and type
scale variables to Tilecast tokens. It does not replace Starlight components.

The design tokens select dark values with the `html.dark` class. Starlight
stores the theme in the `data-theme` attribute. An inline script in
`astro.config.mjs` copies the attribute to the class, so the tokens follow the
Starlight theme picker.

## Localization

English is the canonical language. English pages are at the site root, in
`src/content/docs/`.

Spanish and Russian are not enabled. With no translated pages, Starlight shows
English content below `/es/` and `/ru/`, advertises those paths as translations
to search engines, and shows no fallback notice on the home page. To enable a
language:

1. Add translated pages below `src/content/docs/es/` or
   `src/content/docs/ru/`. Use the same file names as the English pages.
2. Add the locale to `locales` in `astro.config.mjs`:

   ```js
   es: { label: "Español", lang: "es" },
   ru: { label: "Русский", lang: "ru" },
   ```

3. Add `translations` to each sidebar entry that sets its own `label`, for
   example **Home**. Other entries use the title of the translated page.
4. Build the site and examine the language picker and the fallback pages.

Relative links in content keep the reader in the current language. Do not
change them to absolute paths.

## Deployment

`.github/workflows/docs-pages.yml` builds the site from the repository root and
deploys `apps/docs/dist` to GitHub Pages. It runs on pushes to `main` that
change the site or its dependencies. It can also be started manually.
