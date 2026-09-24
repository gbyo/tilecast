# Structured Sources

Tilecast provides native RSS, Atom, JSON, CSV, and Manual Table **Data Sources**. Each is reusable and non-visual. The server keeps one bounded last-known-good payload and manifest v12 projects a common typed field-and-record contract shared by every Widget that consumes it.

## Providers

- RSS and Atom parse standard feed entries. Title, date, author, description excerpt, HTTPS link, and safely discovered HTTPS enclosure images are normalized into typed records. Feed HTML is stripped and never rendered.
- JSON selects a root array and scalar fields with RFC 6901 JSON Pointer. JavaScript, JMESPath functions, templates, expressions, and server-side scripts are not supported.
- CSV accepts a public URL or an uploaded UTF-8 file. The parser detects comma, semicolon, tab, or pipe delimiters unless one is selected, requires a header row, validates every row width, and maps columns by exact header name.

## Field detection

RSS, Atom, JSON, and CSV Sources are inspected before they are mapped. Studio reads the connected data through `POST /api/v1/data-sources/{provider}/inspect` and offers what it found: CSV column names, JSON Pointer paths for the scalar fields of the detected record array, or the record fields a feed actually publishes — each with a few sanitized sample values. A mapping is suggested from those names and applied only while the author has not mapped anything themselves.

Each detected field is also typed from its samples — text, number, date, or datetime — and every sample has to agree, so one timestamp in a column of free text does not mistype the column. Detected timestamps are suggested as mapped values with their type, because the display slots carry one date between them and a Widget that asks for a start and an end can only select fields the Source exposes. A Source whose mapping predates its times offers the fields detection found as a single action instead.

Two consequences are deliberate. A mapped Source (JSON, CSV) has no separate displayed-field list: it displays what it maps, so the mapping is the single place that decision is made, and Author and Description — which only feeds produce — are never offered. A feed offers only the fields that feed carries, so an RSS connection without authors does not present an Author toggle that would render nothing.

Detection uses the same fetch policy, parser, and delimiter detection as a refresh, so what it reports is what playback will use.

All providers support bounded item counts, keyword filtering, source/title/date sorting, list/agenda/card/ticker presentation, refresh and staleness limits, an empty state, preview, typed diagnostics, and last-known-good playback. CSV and mapped data also support up to eight equality or contains filters and twelve optional value fields, each declaring a type — text, number, date, datetime, or URL — that Widget field pickers filter on. A datetime value is stored as an RFC 3339 instant when it can be read; a value that cannot be parsed passes through as text rather than failing the refresh.

Date-aware selection accepts ISO dates, RFC 3339 and supported date-time values, named-month dates, the saved `us_date` (`MM/DD/YYYY`) and `us_short` (`M/D/YYYY`) formats, and explicit `day_first_date` (`DD/MM/YYYY`) and `day_first_short` (`D/M/YYYY`) formats. The existing IDs remain valid for saved Sources. Automatic parsing recognizes ISO, RFC 3339, named-month values, and slash dates only when one numeric component is greater than 12. It leaves ambiguous values such as `03/04/2026` as text; select an explicit month-first or day-first format to parse those. This avoids guessing from the Server, browser, or Player device locale. Studio labels and the Server parser use the same format IDs.

`current_week` uses `organization.first_day_of_week`, including its locale-derived CLDR choice, in Server previews and Player selection. An upgrade migration stores Monday only when an existing installation had no explicit weekday, preserving the prior Player's current-week boundary. Stored administrator choices remain unchanged; new installations use the Sunday registry default.

Manual Table supports up to twelve typed columns and two hundred rows. Supported types are text, number, integer, percent, currency, boolean, date, datetime, and URL. Manual data is immediately ready after saving and does not run through the background refresh worker.

## Release-defined structured Sources

Beyond the providers above, a Tilecast release can ship a structured Data Source as a catalog definition bound to one of three generic adapters. They accept no new code from an operator and are validated at server startup.

- `manual_object` maintains a single typed object (School Status, Emergency Message, Fundraising Goal, Occupancy Count, Today's Hours). Values come from the definition's configuration schema and are projected into the declared output fields; `updatedAt` is generated.
- `manual_records` maintains a bounded table whose rows publish and expire on their own (Announcements, Events, Closures and Delays, Directory, Menu Items, Shout-outs). See "Time-windowed record tables" in `widgets-and-layouts.md` for the `publishAt`, `expiresAt`, and `priority` conventions and the boundary-scheduled refresh.
- `http_records` fetches an endpoint pinned by the definition and maps the response with a fixed set of dot paths or column names (Google Sheet, US Weather Alerts, Public Holidays).

The first two never contact the network. `http_records` uses the same fetch policy described below; in addition, the definition — not the operator — owns the scheme and host, an operator only fills declared placeholders, and every substituted value is percent-encoded so it cannot add a path segment, add a query parameter, or reach another host. A definition that placed a placeholder in its scheme or host, mapped an output field it does not declare, or carried credentials in its template is rejected before the server accepts traffic.

## Security

Dynamic Sources use the same dedicated fetch policy as Calendar Sources. Public URLs require HTTPS and standard ports. Private, loopback, link-local, multicast, and non-global destinations are blocked during validation, redirects, DNS resolution, and connection unless `TILECAST_SOURCE_ALLOW_PRIVATE_NETWORKS=true` is explicitly set. The client does not use environment proxies and enforces total/request-header timeouts, redirect limits, response-size limits, and provider-specific content types.

Displayed strings are stripped of markup, control characters, and excessive length. URLs in records must be credential-free HTTPS URLs. Uploaded CSV bytes remain in the server configuration for refresh and backup but are removed from Studio API responses and Player manifests. Manifest data contains no fetch URL, uploaded bytes, mapping paths, filters, or executable content.

The Player validates the manifest before activation, keeps its previous verified manifest, and renders structured records with native Compose primitives inside the consuming Widget. WebView remains limited to Website and YouTube Widgets. One cached Data Source dataset is shared across every Widget that references it. Cached prepared records remain available during server or upstream outages until their configured staleness deadline.
