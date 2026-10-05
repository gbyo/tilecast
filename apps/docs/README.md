# Tilecast Docs

This workspace builds the public Tilecast documentation site with
[Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/).
The site is published to GitHub Pages at <https://tilecast.org/>.

The public docs are for people who install and operate Tilecast. Engineering
specifications and contracts stay in the repository `docs/` directory.

## Commands

Run these commands from the repository root:

| Command                | Result                                                                |
| ---------------------- | --------------------------------------------------------------------- |
| `npm run docs:dev`     | Starts a local server at `http://localhost:4321/`                     |
| `npm run docs:check`   | Checks redirects, runs the docs tests, and runs `astro check`         |
| `npm run docs:build`   | Builds `apps/docs/dist`, then checks links, redirects, and navigation |
| `npm run docs:preview` | Serves the production build from `apps/docs/dist`                     |

The build uses the Git history for the last-updated date on each page. A
shallow clone shows the wrong date. Use a full clone.

## Files

| Path                                | Contents                                                             |
| ----------------------------------- | -------------------------------------------------------------------- |
| `astro.config.mjs`                  | Site URL, sidebar, theme, and Starlight settings                     |
| `redirects.mjs`                     | Compatibility redirects from retired public paths                    |
| `src/content/docs/`                 | Pages. The file path is the URL path.                                |
| `src/route-middleware.mjs`          | Adds the Edge section banner; hides page actions on generated routes |
| `src/components/SetupAdvisor.astro` | The Setup Advisor wizard shown on `/setup/`                          |
| `src/setup-advisor/model.ts`        | Advisor questions, decision rules, and the guide each step links to  |
| `src/setup-advisor/model.test.ts`   | Tests for the rules and for every guide link the advisor can show    |
| `src/styles/tilecast.css`           | Starlight theme variables mapped to `@tilecast/design-tokens`        |
| `scripts/check-links.mjs`           | Post-build check for internal links and heading anchors              |
| `scripts/check-redirects.mjs`       | Checks the redirect registry and the links that point at a redirect  |
| `scripts/check-navigation.mjs`      | Post-build check that every page is in the sidebar or linked         |
| `STYLE.md`                          | Writing rules for public pages                                       |

Public pages live below `src/content/docs/`. Engineering specifications and
contracts live with the code they describe:

```text
tilecast/
├── apps/docs/src/content/docs/  Public site. Style rules: apps/docs/STYLE.md.
├── docs/                        Engineering references and contracts.
├── wiki/                        Engineering wiki (not published to the site).
└── README.md files              Build, test, and operator notes per area.
```

## Add a page

1. Read [`STYLE.md`](STYLE.md).
2. Add a Markdown file below `src/content/docs/`. Use `.mdx` only when the page
   uses a Starlight component. The route is the same either way.
3. Link the page from the hub for its section. A hub is the landing page that
   the sidebar group opens with, such as `/studio/`, `/players/`, `/manage/`,
   or `/integrations/`, or a small routing page below it. Use a `LinkCard` for
   a main task and a list item for a minor one.
4. Add the page to `sidebar` in `astro.config.mjs` only if a reader needs it as
   one of the few main destinations in its group. Most pages do not.
5. Run `npm run docs:build`. The build checks internal links, redirects, and
   that the page can be reached.

### The sidebar is a task map

The sidebar is a curated, high-level map of what a reader wants to do. It is
not a table of contents, and not every public page belongs in it.

- The sidebar has eight groups: Start here, Create & publish, Screens &
  players, Manage Tilecast, Automate & extend, Troubleshooting, Developers,
  and Reference. Home and Privacy stand alone.
- Keep each group to direct links. Do not add a subgroup. Put deeper material
  on a hub page instead.
- A deeper page can stay out of the sidebar when its hub links to it. It stays
  published and searchable, and it appears in `llms-full.txt` and the Markdown
  copies. Do not set `pagefind: false` or `draft: true` to hide a page from
  navigation.
- The hub is responsible for the deeper pages. When you add a page, add its
  link to the hub in the same change. `npm run docs:build` fails when a page is
  neither in the sidebar nor linked from another page.
- A sidebar entry can point to a page in any directory. The file path is the
  URL, so do not move a file only to match the sidebar.
- Plugin guides are not in the sidebar. Link each one from
  `src/content/docs/operations/plugins.mdx`. A test fails when a plugin guide is
  not linked there.
- The generated endpoint pages under `/reference/api/endpoints/` are also not
  in the sidebar. The sidebar links to their overview page, which lists every
  route.

## Redirects

`redirects.mjs` maps an old public path to its canonical path. Astro reads it
as the `redirects` setting. Add an entry only when a public page moves or is
retired. Keep an entry indefinitely, because people bookmark these paths.

- Write both paths from the site root with a trailing slash, for example
  `"/operations/": "/manage/"`.
- Point each entry at the final page. A redirect must not point to another
  redirect, to itself, or back to its source.
- Delete the page at the old path. A real page takes precedence over a
  redirect, and the check fails while both exist.
- Link to the canonical path from other pages. The check fails when a page
  links to a redirect.

`npm run docs:check` and `npm run docs:build` run `scripts/check-redirects.mjs`.
It rejects malformed paths, loops, chains, self-redirects, missing
destinations, sources that are still pages, and links that go through a
redirect. After the build, it also confirms that Astro wrote each redirect page.

The site is a static build for GitHub Pages and has no server adapter. Astro
writes each redirect as an HTML page that uses a meta refresh and a canonical
link, not as an HTTP 301 response. Browsers and search engines follow it, but
the server never sends the 301 status code.

## Setup Advisor

The page at `/setup/` is an interactive wizard that recommends a deployment and lists the guides to follow. It runs only in the browser and sends nothing anywhere.

- Change questions, rules, and recommendation text in `src/setup-advisor/model.ts`. The first rule in `TOPOLOGY_RULES` that applies wins; there is no scoring.
- Each step in `STEPS` links to a public page. The wizard builds its links at run time, so the link checker cannot see them. `model.test.ts` checks that every page and heading exists, so run `npm test` after you rename or move one of those guides.
- Keep the commands in the guides, not in the advisor. The advisor routes readers to the canonical page.

## Drafts and search

A page with `draft: true` in its frontmatter renders in `npm run docs:dev`
but is excluded from the production build and from search. Use a draft to
keep a page visible while its research or review is incomplete, never to
publish placeholder copy.

`pagefind: false` keeps a utility page such as the custom 404 out of search
results. See [`STYLE.md`](STYLE.md) for when each one applies.

## Agent-friendly output

The build also emits machine-readable documentation next to the HTML pages:

| Output           | Contents                                                             |
| ---------------- | -------------------------------------------------------------------- |
| `llms.txt`       | Index of the public docs for coding assistants, with page summaries. |
| `llms-full.txt`  | The full public docs text in one file.                               |
| `llms-small.txt` | A compact index for smaller context windows.                         |
| Copy page        | Each page has a Copy action above its table of contents.             |
| View as Markdown | Each page has a cleaned Markdown version for reading or pasting.     |

These outputs cover the same public pages as the site. Draft pages are
excluded. Engineering documents in `docs/` are not public product
documentation and are not included.

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
