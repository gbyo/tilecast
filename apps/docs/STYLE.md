# Tilecast Docs writing style

This is the writing contract for the public documentation site, the pages under
`apps/docs/src/content/docs/`. Read it before you add or edit a page.

The public docs are written for people who install and run Tilecast: IT staff
at a school, a librarian, a volunteer at a church, someone in a city office.
Most of them want to finish a task and get back to their day.

## Two styles in one repository

Tilecast keeps two kinds of documentation, and they follow different rules.

| Documentation                                                                                                    | Location                            | Style                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Public docs: tasks, concepts, and reference for people using Tilecast                                            | `apps/docs/src/content/docs/`       | This file                                                                                       |
| Engineering docs: specifications, protocol contracts, implementation records, and operator-grade technical notes | `docs/`, `wiki/`, `README.md` files | ASD-STE100-oriented rules in [`docs/documentation-style.md`](../../docs/documentation-style.md) |

The engineering docs stay precise and literal because they are contracts. The
public docs can sound like a person, because they are explaining something to
one. When a public page needs the exact contract, link to it instead of
restating it.

## Write for the reader's task

Start from what the reader is trying to do, not from how Tilecast models it.

- Title a task page with the task: "Pair a display", not "Pairing sessions".
- Put the result or the instruction first. Background can follow.
- Cut a sentence if the reader would not miss it.
- Keep paragraphs short. Three or four sentences is plenty.
- Don't open with "This section will…" or with a sentence that repeats the
  heading. Start with the first useful thing.
- Don't end with a paragraph that summarizes what the page just said.

## Voice and tone

Aim for calm, specific, and useful. Write like someone who knows the product
and respects the reader's time.

- Address the reader as "you".
- Use active voice. Say who does what: "Studio shows the pairing code", not "The
  pairing code is shown".
- Use ordinary contractions such as "don't", "it's", and "you'll" where they
  make the sentence sound natural. Don't force them.
- Write for an international audience. Avoid idioms, jokes, and cultural
  references. Many readers use a translation tool.
- Don't call a procedure easy, simple, quick, or obvious. It may not be for the
  person reading it.
- Don't praise Tilecast. Describe what it does and let the reader decide.

### Words and patterns to avoid

These read as filler or as generated text. Rewrite the sentence instead of
swapping in a synonym.

| Avoid                                                | Write instead                          |
| ---------------------------------------------------- | -------------------------------------- |
| "Welcome to the comprehensive guide to…"             | Start with what the page helps you do. |
| "Whether you're a beginner or an experienced…"       | Write for the reader in front of you.  |
| powerful, robust, seamless, seamlessly, effortlessly | Name the actual behavior or limit.     |
| leverage, utilize                                    | use                                    |
| unlock, dive into, in today's…                       | Say the plain action.                  |
| easy, simple, just, obviously                        | Remove the word.                       |
| Stacks of adjectives                                 | One precise adjective, or none.        |
| Frequent em dashes                                   | A period, a comma, or parentheses.     |
| Exclamation marks and general enthusiasm             | A plain statement.                     |

## Headings and titles

- Use sentence case: "Connect a display", not "Connect A Display".
- Keep one `h1` per page. Starlight renders it from the `title` frontmatter, so
  start the body at `##`.
- Don't skip heading levels.
- Make headings specific enough to scan. "Before you start" is fine;
  "Overview" on every page is not.

## Names and formatting

- Use exact product names: **Tilecast**, **Tilecast Server**, **Tilecast
  Studio** (or **Studio** after first use), and **Tilecast Player** (or
  **Player**).
- Use Tilecast's own terms with the same capitalization Studio uses: Display
  Group, Data Source, Widget, Layout, Campaign, Owner, Administrator.
- Use **bold** for UI labels exactly as they appear in Studio or on the Player:
  select **Pair screen**, then **Approve and pair**.
- Use `code` for commands, file paths, API fields, settings keys, environment
  variables, and literal values: `TILECAST_PUBLIC_URL`, `deploy/docker/.env`,
  `true`.
- Put commands the reader runs in fenced code blocks with a language, such as
  `sh` or `dotenv`. Show one command per block when the reader runs them one at
  a time.
- Use Expressive Code metadata when it adds context: give a terminal block a
  short `title="..."` when the reader needs to know where or why to run it,
  and use text markers only to call attention to the line or value that changes.
  Do not title or highlight every snippet for decoration.
- Use example addresses from the documentation ranges, such as `192.0.2.10` and
  `signage.example.org`. Never show a real token, password, or internal
  hostname.

## Explain terms when they first matter

Explain a Tilecast term the first time a new reader is likely to meet it, in
the sentence where it appears:

> Tilecast Player shows a six-character **pairing code**. You enter that code in
> Studio to approve the display.

Don't build a glossary into every page. Link to a reference page for the full
definition once one exists.

## Procedures

- Use Starlight's `<Steps>` component for an ordered task the reader performs.
  Import it from `@astrojs/starlight/components` and wrap the whole ordered
  list. A page that uses a component must be `.mdx`; the route stays the same.
- Start each step with an imperative verb: "Open", "Select", "Enter", "Run".
- Put one action in each step. A step can end with the result the reader should
  see.
- Don't wrap a short ranked list or a conceptual sequence in `<Steps>`. The
  policy-precedence list in "Set Player policies" stays a normal numbered
  list, for example.
- List prerequisites only when the procedure fails without them. Put them in a
  short "Before you start" section.
- Put a warning, limit, or recovery step next to the action it affects, not in a
  separate section at the end.
- Use Starlight asides (`:::note`, `:::caution`, `:::danger`) sparingly. A
  caution is for something that can lose data, lock someone out, or leave a
  display blank.

```mdx
import { Steps } from "@astrojs/starlight/components";

<Steps>

1. Open **Screens** > **Fleet**.
2. Select **Pair screen**.

</Steps>
```

## Equivalent choices

- Use Starlight's `<Tabs>` with `<TabItem>` when two paths accomplish the same
  task, such as Android TV and Linux install or update behavior.
- Synchronize repeated choices with `syncKey`. Player platform tabs use
  `syncKey="player-platform"` with the labels `Android TV` and `Linux`, so a
  reader's choice carries across pages. API language tabs use
  `syncKey="api-example-language"`.
- Don't hide fundamentally different workflows behind tabs. The Android and
  Linux install guides stay separate pages; tabs cover only the parts that
  are truly parallel.
- Don't invent a redundant example only to justify a tab set.

## Filesystem structures

- Use Starlight's `<FileTree>` for an actual file or volume hierarchy, such as
  the repository layout or the Docker volume contents. Text after the file
  name renders as a comment: `- tilecast_data/ Media and backups.`
- Don't use `FileTree` for ordinary lists.

## Links, buttons, and labels

- Use a normal inline link for references inside a sentence.
- Use Starlight's `<LinkButton>` only for a page's strongest next action, such
  as the end of Getting Started or a developer page pointing at the
  contribution guide. Prefer `primary` for the main next step, `secondary`
  for a supporting one, and `minimal` for a quiet external link. Don't put
  five buttons on a page.
- Use Starlight's `<Badge>` only for a platform, capability, lifecycle, or
  plugin status that changes what the reader should do, such as `Linux only`
  or `US` on a capability table. Don't badge ordinary pages or decorate text
  with labels like "Core" or "Recommended".
- Sidebar badges follow the same rule. They are configured in
  `astro.config.mjs` next to the page's slug and must stay readable in light
  and dark themes on narrow screens. Don't add a `New` badge without a plan
  for removing it.
- Prefer Starlight's built-in icon names for component and hero-action icons.
  Don't import an icon library into the docs for decoration.

## Drafts, search, and banners

- If a page is worth keeping while research or review is incomplete, mark it
  `draft: true` instead of publishing placeholder copy. Drafts render during
  local development but are excluded from the production build. Never publish
  "Coming soon", a fake guide, or guessed functionality.
- Use `pagefind: false` only for pages that should genuinely not appear in
  search, such as the custom 404 page. Don't exclude a page only because it
  is short.
- A page banner (`banner:` frontmatter) is for a meaningful temporary notice
  such as a breaking upgrade requirement or deprecated functionality. Don't
  add a banner to announce the docs themselves. The Tilecast Edge preview
  banner is applied to the whole Edge section by `src/route-middleware.mjs`;
  add a page-level caution there only when that page has an additional,
  specific risk or limitation.

## Tutorials and quickstarts

- Tell the reader what they'll have when they finish, in the first paragraph.
- Keep to one path. Link to alternatives instead of branching inside the steps.
- End with two to four next steps that follow from what the reader just did.

## Examples

Prefer a concrete example to an abstract explanation. "Schedule the lunch menu
for weekdays from 10:30 to 13:00" teaches more than "Schedules define time
windows for content".

## Accuracy

- Document what Tilecast does today. Check the current code, Studio labels, or
  the engineering docs before you describe a behavior.
- Don't describe planned features, and don't write placeholder pages. A section
  that has no content yet should not have a page yet. When a page is worth
  keeping while its review is incomplete, mark it `draft: true` (see
  "Drafts, search, and banners") instead of publishing a guess.
- State real limits plainly. If a feature depends on the network, the device,
  or the firmware, say so where the reader makes that choice.

## Links

- Use descriptive link text: "see [Installation](../installation/)", not
  "click [here](../installation/)".
- Link between pages with relative paths that end in a slash, such as
  `../installation/`. The site is served under `/tilecast/`, and relative links
  keep working if that base or the page's language changes.
- Link to engineering docs on GitHub with full `https://github.com/gbyo/tilecast/`
  URLs.

## Images

- Add an image only when it helps the reader find something or confirm a
  result.
- Give every meaningful image alt text that says what it shows. Use empty alt
  text only for a decorative image.
- Don't rely on color alone. Point to a label or position as well.

## Localization

English is the canonical language. Write sentences that translate well: one
idea in each sentence, a clear subject, and no idioms. Spanish and Russian can
be added later without moving the English pages; see [`README.md`](README.md).
