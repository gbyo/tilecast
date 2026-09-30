# ADR: two WebPages, one data store for iOS native presentations

Status: accepted, iOS Milestone 4.

## Context

The iOS app must show some Studio surfaces in a native SwiftUI sheet, with native chrome, and Studio must continue to own their content. The main Studio page cannot show content in a sheet above itself. A second Studio frontend is expensive to start.

## Decision

- The app keeps one main Studio `WebPage` and at most one presentation `WebPage` for the active server.
- Both pages use the server's persistent `WKWebsiteDataStore`. The presentation page gets the Studio session cookie from the store. No credential crosses the bridge.
- Each page has its own configuration and its own bridge. The bridge context (`main` or `presentation`) decides which messages the bridge accepts.
- The app prewarms the presentation page after signed-in Studio negotiates presentations, and reuses it. Studio changes its route with `presentation/show`, and the presentation id keys the content.
- The app discards the presentation page under memory pressure when it is hidden, and with its main page.
- The auxiliary page stays separate and has no bridge.
- The app knows only the `/__native/modal` root. Studio owns the child routes.

## Consequences

- A new presentation is a Studio route and needs no Swift change.
- The app keeps a second web content process while the page is cached.
- Milestone 4 has no stacked native presentations. A dialog in a presentation shows in the presentation page.
