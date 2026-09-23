// First-paint appearance only. Runtime theme updates (including
// prefers-color-scheme changes) are owned by the React ThemeProvider;
// this script must not install a permanent media-query listener that
// competes with it.
(() => {
  const root = document.documentElement;
  const applyClass = (appearance) => {
    const dark =
      appearance === "dark" ||
      (appearance === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", dark);
  };
  try {
    const value = localStorage.getItem("tilecast.appearance");
    applyClass(["light", "dark", "system"].includes(value) ? value : "system");
  } catch {
    applyClass("system");
  }
})();
