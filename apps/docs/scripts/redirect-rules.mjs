// @ts-check
// Rules for the redirect registry in redirects.mjs. Each function takes plain
// data and returns a list of problems, so the rules are unit-tested without a
// build. scripts/check-redirects.mjs applies them to the real site.

/** A site path: starts and ends with "/", with plain segments in between. */
const internalPath = /^\/(?:[A-Za-z0-9._~-]+\/)*$/;

/**
 * @param {Record<string, string>} redirects old path to canonical path
 * @param {{ routes: Iterable<string>, generatedPrefixes?: string[] }} site
 * @returns {string[]}
 */
export function registryProblems(redirects, site) {
  const routes = new Set(site.routes);
  const generated = site.generatedPrefixes ?? [];
  const entries = Object.entries(redirects);
  const sources = new Set(Object.keys(redirects));
  const problems = [];

  for (const [from, to] of entries) {
    const label = `${from} -> ${to}`;
    let wellFormed = true;
    for (const [role, path] of [
      ["source", from],
      ["destination", to],
    ]) {
      if (!internalPath.test(path) || path.split("/").includes("..")) {
        problems.push(
          `${label}: the ${role} must be an internal path that starts and ends with "/"`,
        );
        wellFormed = false;
      }
    }
    if (!wellFormed) continue;

    if (from === "/") {
      problems.push(`${label}: the home page cannot be a redirect source`);
    }
    if (from === to) {
      problems.push(`${label}: a redirect points to itself`);
      continue;
    }
    if (routes.has(from)) {
      problems.push(
        `${label}: ${from} is still a real page, and a real page wins over a redirect. Remove the page or the entry.`,
      );
    }

    // Follow the destination: a loop and a chain are different mistakes.
    const seen = new Set([from]);
    let next = to;
    let loop = false;
    while (sources.has(next)) {
      if (seen.has(next)) {
        loop = true;
        break;
      }
      seen.add(next);
      next = /** @type {string} */ (redirects[next]);
    }
    if (loop) {
      problems.push(
        `${label}: redirect loop (${[...seen, next].join(" -> ")})`,
      );
      continue;
    }
    if (sources.has(to)) {
      problems.push(
        `${label}: redirect chain. ${to} is itself redirected to ${redirects[to]}; point ${from} at its final page.`,
      );
      continue;
    }
    if (!routes.has(to) && !generated.some((prefix) => to.startsWith(prefix))) {
      problems.push(`${label}: the destination is not a page on this site`);
    }
  }
  return problems;
}

/**
 * Links that point at a redirect source when they could point at its
 * canonical page.
 * @param {{ where: string, target: string }[]} links resolved internal links
 * @param {Record<string, string>} redirects
 * @returns {string[]}
 */
export function aliasLinkProblems(links, redirects) {
  return links.flatMap(({ where, target }) =>
    Object.hasOwn(redirects, target)
      ? [
          `${where}: links to ${target}, which redirects. Link to ${redirects[target]} instead.`,
        ]
      : [],
  );
}
