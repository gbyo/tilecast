const appearanceKey = "tilecast.appearance";
const appearances = new Set(["light", "dark", "system"]);

function readAppearance() {
  try {
    const value = window.localStorage.getItem(appearanceKey);
    return value && appearances.has(value) ? value : "system";
  } catch {
    return "system";
  }
}

if (!appearances.has(document.documentElement.dataset.theme ?? "")) {
  document.documentElement.dataset.theme = readAppearance();
}

new MutationObserver(() => {
  const value = document.documentElement.dataset.theme;
  if (!value || !appearances.has(value)) return;
  try {
    window.localStorage.setItem(appearanceKey, value);
  } catch {
    // Storage can be unavailable in hardened or private browser contexts.
  }
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});
