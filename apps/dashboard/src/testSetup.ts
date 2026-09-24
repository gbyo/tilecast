// Shared Vitest setup for the dashboard suite.
//
// Testing Library's async helpers default to a one-second timeout. That is generous for a single
// file but not when Vitest runs many jsdom environments in parallel on a small machine: CI runners
// have two cores, and under that contention a render that normally settles in tens of milliseconds
// can cross the deadline. The result was a suite that failed a different test on each run — the
// symptom of a timeout, not of a broken assertion.
//
// Raising the ceiling does not hide real failures. A test whose condition never becomes true still
// fails; it simply waits longer before saying so.
import { configure } from "@testing-library/dom";
import { initI18n } from "./i18n";

configure({ asyncUtilTimeout: 5000 });

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
}

// Components render English text through i18next, so tests keep asserting on
// the English copy they always have.
await initI18n("en");
