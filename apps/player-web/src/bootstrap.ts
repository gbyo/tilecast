/** Run before importing the application, loading resources or opening storage. */
export function takeRecoverySecret(
  location: Location,
  history: History,
): string | null {
  const fragment = location.hash;
  // Scrub all fragment content, including invalid input, before parsing it.
  history.replaceState(null, "", location.pathname + location.search);
  const parameters = new URLSearchParams(fragment.slice(1));
  const values = parameters.getAll("r");
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]!)
    ? values[0]!
    : null;
}
