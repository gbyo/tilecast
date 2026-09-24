# Studio localization

Tilecast Studio is translated with [i18next](https://www.i18next.com/) and
[react-i18next](https://react.i18next.com/). English is the source language.
Spanish (`es`) and Russian (`ru`) ship alongside it.

All sixteen Studio namespaces (`account`, `activity`, `alerts`, `auth`,
`common`, `content`, `errors`, `forms`, `layouts`, `navigation`, `playlists`,
`plugins`, `review`, `schedules`, `screens`, `settings`) are converted: no
user-facing English remains outside the exclusions below. This document is the
contract for keeping it that way — run `npm run i18n:scan` from
`apps/dashboard` and fix every finding that is not an intentional exclusion.

Tilecast Player and the server are out of scope. Player strings live in the
Android, Linux, and Windows projects. Server error messages stay English and
are translated in Studio by error code (see [API errors](#api-errors)).

## How it works

| Piece                     | Location                                                     |
| ------------------------- | ------------------------------------------------------------ |
| i18next instance, helpers | `apps/dashboard/src/i18n/index.ts`                           |
| Supported languages       | `apps/dashboard/src/i18n/languages.ts`                       |
| Namespace registry        | `apps/dashboard/src/i18n/resources.ts`                       |
| Key types                 | `apps/dashboard/src/i18n/i18next.d.ts`                       |
| Strings                   | `apps/dashboard/src/locales/<language>/<namespace>.json`     |
| Parity test               | `apps/dashboard/src/i18n/locales.test.ts`                    |
| Untranslated-text scan    | `apps/dashboard/scripts/i18n-scan.mjs` (`npm run i18n:scan`) |
| Russian glossary          | `docs/localization/ru-reference.json`                        |

- **English is bundled** and defines the TypeScript key types. A misspelled key
  fails `tsc`.
- **Spanish and Russian are split into their own chunks.** They are fetched only
  when chosen, so an English installation downloads no translations.
- **Studio waits for the starting language** before its first render (`initI18n`
  in `main.tsx`), so a Russian reader never sees a flash of English. If a chunk
  fails to load, English renders instead.
- **Missing keys fall back to English.** The parity test fails the build before
  that can ship.

### Choosing the language

The per-user setting `preference.language` lives in the server settings
registry: `system`, `en`, `es`, or `ru`, defaulting to `system`. People change
it under **My Account → Preferences**, and the choice previews live until they
save or cancel.

- `system` uses the first browser language Studio ships, matched on the primary
  subtag (`es-MX` → `es`), and otherwise falls back to English.
- The last applied preference is cached in `localStorage` (`tilecast.language`),
  so sign-in, setup, and the first paint after a reload are already in the
  right language.
- Once the account's saved preference loads, `DashboardShell` applies it; the
  saved preference beats the cache.
- `<html lang>` follows the active language.

## Converting a file

Work through one file (or one small feature folder) at a time:

1. **Run the scan** to see what is left:
   `npm run i18n:scan -- src/pages/UsersPage.tsx`
2. **Add keys** to the right namespace file in `src/locales/en/`, following the
   [key conventions](#keys).
3. **Add the same keys** to `src/locales/es/` and `src/locales/ru/` in the same
   change. The parity test requires all three to match.
4. **Replace each literal** with `t(...)` (patterns below).
5. **Verify.** Everything below must pass:

   ```sh
   npm run i18n:scan -- --check src/pages/UsersPage.tsx
   npx tsc -b
   npm test
   npm run lint
   npm run format:check   # from the repository root
   ```

Existing tests assert on English text. Tests run in English, so a correct
conversion leaves them passing unchanged. If a test breaks, the English string
changed, and it should not have. Keep the English copy word-for-word identical
unless you are deliberately fixing it.

`--check` exits non-zero while a file still has findings. The scan is a
heuristic. For a literal that must stay English (a code sample, a protocol
token, a value compared against the API), put `i18n-ignore` in a comment on
that line or the line above:

```tsx
<p>
  {/* i18n-ignore: HDMI-CEC command name */}
  <code>standby</code>
</p>
```

The scan does not see every case. Also look for text built from strings in
helpers, `new Error("…")` that reaches the screen, and Zod messages.

### Intentional exclusions

These stay English on purpose, each marked `i18n-ignore` at the site:

- **Brand names.** The `Tilecast` and `Tilecast Studio` logo labels are
  proper nouns; every locale keeps the product name untranslated.
- **Test fixtures.** `src/plugins/catalogFixtures.ts` mirrors
  server-shaped English records for tests. Server data stays English and is
  translated by code in Studio.

## Namespaces

Each feature area has its own namespace, so separate conversions touch
separate JSON files and rarely conflict. Add strings to the namespace of the
feature that owns them; a reused string goes in `common`.

| Namespace    | Covers                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `common`     | Generic verbs and states shared everywhere: Save, Cancel, Loading…, item counts. Keep it small.                                       |
| `navigation` | `AppSidebar`, `StudioTopbar`, command palette, `navigation/studioRoutes.tsx`, `PageHeader`, route error boundary                      |
| `auth`       | `AuthPage`, `SetupFlow`, `EnrollmentWizard`, `auth/schemas.ts`, WebAuthn prompts                                                      |
| `errors`     | Generic error text and `codes.<api_error_code>` translations                                                                          |
| `account`    | `MyAccountPage`, `PreferencesPage`, `UsersPage`, `SecurityPage`                                                                       |
| `settings`   | `SettingsPage`, everything in `src/settings/`, and the server setting titles (`definitions.*`)                                        |
| `screens`    | `ScreensPage`, screen detail, pairing, `ArchivedScreensPage`, `FleetBulkPage`, `ScreenScopeEditor`, display groups, screen components |
| `content`    | `ContentPage` (media), `WidgetsPage`, `DataSourcesPage`, `src/content/`, content picker, `DependencyGraphPage`                        |
| `review`     | `ApprovalsPage`, `ContentReviewPage`, `ContentSubmissionInboxPage`                                                                    |
| `playlists`  | Playlist pages, `components/playlist-editor/`, `PlaylistRevisionsPanel`                                                               |
| `layouts`    | `LayoutsPage`, `LayoutEditorPage`, `components/layout-editor/`, `SpanWallEditor`                                                      |
| `schedules`  | `SchedulesPage`, `src/schedules/`, `TimeRangePicker`, date picker                                                                     |
| `activity`   | `Activity*` pages, `OperationsDashboard`, `FleetUptimePanel`, `MetricTile`, `src/notifications/`                                      |
| `forms`      | `Forms*` pages, `FormDataSourcePage`, `CreateFormDataSourcePage`, `src/forms/`                                                        |
| `plugins`    | `PluginsPage`, `src/plugins/`, `BrandBugsPage`, `CountdownBarsPage`, `NoiseMeter*` pages                                              |
| `alerts`     | `EmergencyAlertsPage`, `CampaignsPage`, `QuickPresentDialog`, `AirPlayPresentDialog`, `LiveStreamDialog`, presentations               |

`components/ui/` primitives contain a few screen-reader strings ("Close",
"More"). Put those in `common`.

To add a namespace, create `<name>.json` in **every** locale directory. Then
register it in `src/i18n/resources.ts`.

## Keys

- **Semantic and nested**, never the English sentence:
  `users.addForm.passwordHint`, not `"Passwords must contain at least 12 characters."`.
  i18next treats `.` and `:` in a key as separators, so an English-sentence key
  breaks.
- **camelCase segments.** Group by the page or component, then by the part of
  the UI: `users.table.lastSignedIn`, `users.deleteDialog.title`.
- **One key per distinct meaning.** Do not reuse a key only because the English
  happens to match. "Open" as a verb on a button and "Open" as a status translate
  differently in Russian.
- **Do not build sentences from fragments.** `"Deactivate {{name}}?"` is one key.
  `t("deactivate") + name + "?"` cannot be translated, because word order and
  case endings differ between languages.

## Patterns

### In a component

The first namespace is the default for unprefixed keys. List every other
namespace the component uses, so prefixed keys type-check:

```tsx
import { useTranslation } from "react-i18next";

export function UsersPage() {
  const { t } = useTranslation(["account", "common"]);
  return (
    <>
      <h2>{t("users.addForm.title")}</h2>
      <Button>{t("common:actions.cancel")}</Button>
      <Input placeholder={t("users.editForm.passwordPlaceholder")} />
    </>
  );
}
```

`src/settings/SettingsActionBar.tsx` and `src/pages/PreferencesPage.tsx` are
converted reference examples.

### Interpolation

```json
{ "deleteDialog": { "title": "Permanently delete {{name}}?" } }
```

```tsx
t("users.deleteDialog.title", { name: user.name });
```

React escapes the output; do not escape again. Keep placeholder names identical
in every language. The parity test checks this.

### Plurals

Never write `count === 1 ? "item" : "items"`. Give the key suffixed forms and
pass `count`:

| Language | Required forms                    |
| -------- | --------------------------------- |
| English  | `_one`, `_other`                  |
| Spanish  | `_one`, `_many`, `_other`         |
| Russian  | `_one`, `_few`, `_many`, `_other` |

These are the CLDR categories from `Intl.PluralRules`, and the parity test
requires every one of them. Russian `_one` also covers 21, 31, and so on, so it
must include `{{count}}`. Spanish `_many` is used for exact millions ("1 000 000
de elementos"). This is `ru/common.json`:

```json
{
  "count": {
    "items_one": "{{count}} элемент",
    "items_few": "{{count}} элемента",
    "items_many": "{{count}} элементов",
    "items_other": "{{count}} элемента"
  }
}
```

```tsx
t("common:count.items", { count: playlist.items.length });
```

### Markup inside a sentence

Use `<Trans>` rather than splitting a sentence around a link or `<strong>`:

```json
{ "empty": "No screens yet. <pairLink>Pair a screen</pairLink> to begin." }
```

```tsx
import { Trans } from "react-i18next";

<Trans
  i18nKey="list.empty"
  ns="screens"
  components={{ pairLink: <Link to="/screens/pair" /> }}
/>;
```

Tag names must match across languages. The parity test checks this.

### Module-level constants

A `t` call at module scope runs once at import, before any language has loaded,
and never updates. Store keys, and translate at render:

```tsx
// Before
const tabs = [{ id: "all", label: "All screens" }];

// After
const tabs = [{ id: "all", labelKey: "list.tabs.all" }] as const;

function ScreenTabs() {
  const { t } = useTranslation("screens");
  return tabs.map((tab) => <Tab key={tab.id}>{t(tab.labelKey)}</Tab>);
}
```

When a key cannot be kept as a literal type, change the constant into a
function that takes `t` (`function tabs(t: TFunction<"screens">)`).

### Outside React

Helpers that build text should take the `t` they need, or return keys and let
the caller translate. Import the shared `i18n` from `@/i18n` only for code that
runs at call time, never at import time, such as a toast raised inside a
mutation callback. A component that shows that text must still call
`useTranslation()`; that call is what re-renders it on a language change.

### Zod schemas

Build the schema inside the component (or a `makeSchema(t)` function) so
messages are translated:

```tsx
const schema = useMemo(
  () => z.object({ name: z.string().min(1, t("users.addForm.nameRequired")) }),
  [t],
);
```

### Dates and numbers

Studio already formats through `Intl` and `toLocale*`, mostly with `undefined`,
which means the browser locale. Replace that `undefined` with the formatting
locale so dates and numbers match the interface language:

```tsx
const locale = useFormatLocale(); // from "@/i18n"
date.toLocaleDateString(locale, { month: "short", day: "numeric" });
```

`useFormatLocale` keeps the browser's region when it shares the interface
language (an `en-GB` browser in English still gets day-first dates). Otherwise
it uses the interface language. For relative times with `date-fns`, pass the
matching `date-fns/locale` (`es`, `ru`) through the same choice.

Do not translate the organization's regional-format settings
(`organization.locale`, timezones, first day of week). They describe the
installation, not the reader. The separate regional-formatting contract
controls how organization-authored content and values appear on signage; it
does not translate every Player or Server interface string. `preference.language`
continues to control the individual person's Studio interface. The organization
locale, timezone, date/time preferences, and first day of week control signage
formatting and organization-level date semantics. A widget's explicit format
wins over organization defaults, and a field's explicit ISO 4217 currency code
determines the currency independently of locale. See [Settings and player
policies](settings.md#regional-formatting) and [Player configuration](player-protocol.md).

Locale tags use standard BCP-47 parsing/canonicalization. The browser uses the
ECMA-402 `Intl` APIs for locale and time-zone data; the server derives the
locale week default from CLDR supplemental week data. `Intl.Locale.getWeekInfo`
and `Intl.supportedValuesOf("timeZone")` provide modern runtime data, with
compatibility fallbacks where those APIs are not available. See the [ECMA-402
specification](https://402.ecma-international.org/), [MDN `getWeekInfo`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Locale/getWeekInfo), [MDN `supportedValuesOf`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/supportedValuesOf), and [CLDR date and week data](https://unicode-org.github.io/cldr/ldml/tr35-dates.html).

### Server-provided text

Some English comes from the API rather than from Studio. Translate it at
display time with `translateKnown(key, fallback)`. That helper returns the
server's English when English has no key, so a new server value never renders
as a raw key.

- **Setting titles and descriptions.** The settings registry sends `title` and
  `description`. Use keys `settings:definitions.<setting key>.title` and
  `.description`, nesting on the setting key's own dots:

  ```json
  {
    "definitions": {
      "preference": { "density": { "title": "Interface density" } }
    }
  }
  ```

  ```tsx
  translateKnown(
    `settings:definitions.${definition.key}.title`,
    definition.title,
  );
  ```

- **Enum values** (`settingDisplay.ts` `enumLabels`) use
  `settings:enumValues.<value>`, again through `translateKnown`.
- <a id="api-errors"></a>**API errors.** Show the result of
  `apiErrorMessage(error)` instead of `error.message`. English readers always
  get the server's own, often more specific, message. Other languages get
  `errors:codes.<code>` when that key exists, else the server message. Add a
  code to `errors.json` only when the server's message for that code is fixed
  and generic. If the message names a specific resource or limit, a code-level
  translation would lose that detail.

## What not to translate

- Anything a person typed: screen, playlist, and user names, form content, and
  widget text.
- Product names: **Tilecast**, **Tilecast Studio**, **Tilecast Player**. Keep
  them in Latin script in every language.
- Protocol and configuration values: error codes, setting keys, environment
  variables (`TILECAST_SMTP_HOST`), URLs, file extensions, keyboard key names in
  code, `_tilecast._tcp.local`.
- The language names in the language picker. Each one is written in its own
  language on purpose.
- Log output, console messages, and test fixtures.

## Translation style

The interface is restrained infrastructure software. Translations should be as
plain and short as the English. Do not pad them to sound friendlier.

**Russian.** Address the reader as «вы» (lowercase). Use «ё» consistently.
Quote with «ёлочки». For buttons, use the infinitive («Сохранить», «Удалить»).

**Spanish.** Use neutral Latin American Spanish with «tú». Avoid vocabulary
specific to Spain. For buttons, use the infinitive («Guardar», «Eliminar»).
Use sentence case and opening marks (¿ ¡).

### Terminology

Use the same term for a product concept everywhere.

| English       | Spanish               | Russian         |
| ------------- | --------------------- | --------------- |
| Screen        | pantalla              | экран           |
| Display Group | grupo de pantallas    | группа экранов  |
| Player        | reproductor           | проигрыватель   |
| Pair (screen) | vincular              | подключить      |
| Media         | multimedia            | медиа           |
| Playlist      | lista de reproducción | плейлист        |
| Layout        | diseño                | макет           |
| Schedule      | programación          | расписание      |
| Widget        | widget                | виджет          |
| Data Source   | fuente de datos       | источник данных |
| Takeover      | toma de control       | временный показ |
| Activity      | actividad             | активность      |
| Owner         | propietario           | владелец        |
| Administrator | administrador         | администратор   |
| Editor        | editor                | редактор        |
| Viewer        | lector                | наблюдатель     |

### Russian reference glossary

`docs/localization/ru-reference.json` has about 2,100 English → Russian pairs.
They were extracted from the Russian interface in the
[arspavel/tilecast](https://github.com/arspavel/tilecast) fork (`tilecast-ru`
branch). That fork is also AGPL-3.0; its translations are the work of its
contributors.

Use the glossary as a starting point for wording and terminology, not as a
drop-in source:

- The fork translated by rewriting rendered DOM text, so some entries are
  sentence fragments (`". This saves as a reusable"`). Do not copy fragments.
  Translate the whole sentence.
- Some entries are keyed on English that has since changed.
- The fork used gender-neutral shortcuts like «элемент(а)» where a plural was
  needed. Replace them with real plural forms.

Nothing loads this file at runtime. It can be deleted once the conversion is
complete.

## Adding a language

1. Add the code to `SUPPORTED_LANGUAGES` and `NATIVE_LANGUAGE_NAMES` in
   `src/i18n/languages.ts`.
2. Add it to `preference.language` in
   `apps/server/internal/settings/registry.go`, and to the registry test.
3. Copy `src/locales/en/` to `src/locales/<code>/` and translate every file.
   The parity test lists what is missing, including that language's plural
   categories.
