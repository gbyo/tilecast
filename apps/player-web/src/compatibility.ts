/** Required platform plumbing. Presentation support is negotiated with Runtime. */
export function missingCapabilities(): string[] {
  return [
    [
      "a secure HTTPS connection",
      globalThis.isSecureContext && location.protocol === "https:",
    ],
    ["WebCrypto device keys", !!globalThis.crypto?.subtle],
    ["IndexedDB", !!globalThis.indexedDB],
    [
      "Origin Private File System",
      typeof navigator.storage?.getDirectory === "function",
    ],
    ["Web Locks", !!navigator.locks],
    ["service workers", "serviceWorker" in navigator],
    ["streaming downloads", typeof ReadableStream !== "undefined"],
  ]
    .filter(([, supported]) => !supported)
    .map(([name]) => String(name));
}
