document.documentElement.classList.add("style-vega");

const appearanceKey = "tilecast.appearance";
const appearances = new Set(["light", "dark", "system"]);
const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

function readAppearance() {
  try {
    const value = window.localStorage.getItem(appearanceKey);
    return value && appearances.has(value) ? value : "system";
  } catch {
    return "system";
  }
}

function syncResolvedAppearance() {
  const appearance = document.documentElement.dataset.theme ?? "system";
  const dark =
    appearance === "dark" || (appearance === "system" && darkMedia.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

if (!appearances.has(document.documentElement.dataset.theme ?? "")) {
  document.documentElement.dataset.theme = readAppearance();
}
syncResolvedAppearance();

new MutationObserver(() => {
  const value = document.documentElement.dataset.theme;
  if (!value || !appearances.has(value)) return;
  syncResolvedAppearance();
  try {
    window.localStorage.setItem(appearanceKey, value);
  } catch {
    // Storage can be unavailable in hardened or private browser contexts.
  }
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

darkMedia.addEventListener("change", syncResolvedAppearance);
