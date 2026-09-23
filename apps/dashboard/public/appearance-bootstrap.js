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
    const appearance = ["light", "dark", "system"].includes(value)
      ? value
      : "system";
    applyClass(appearance);
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        applyClass(appearance);
      });
  } catch {
    applyClass("system");
  }
})();
