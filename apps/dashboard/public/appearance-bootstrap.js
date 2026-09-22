(() => {
  const root = document.documentElement;
  try {
    const value = localStorage.getItem("tilecast.appearance");
    const appearance = [
      "light",
      "dark",
      "system",
    ].includes(value)
      ? value
      : "system";
    root.dataset.appearance = appearance;
    root.dataset.theme = appearance;
    if (appearance === "system") delete root.dataset.colorScheme;
    else root.dataset.colorScheme = appearance;
  } catch {
    root.dataset.appearance = "system";
    root.dataset.theme = "system";
    delete root.dataset.colorScheme;
  }
})();
