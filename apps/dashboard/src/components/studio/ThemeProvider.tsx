import { useEffect, type ReactNode } from "react";

type Appearance = "light" | "dark" | "system";

function isDark(appearance: Appearance) {
  if (appearance === "dark") return true;
  return (
    appearance === "system" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function ThemeProvider({
  appearance = "system",
  density = "comfortable",
  reducedMotion = false,
  children,
}: {
  appearance?: string;
  density?: string;
  reducedMotion?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const value: Appearance =
      appearance === "light" || appearance === "dark" ? appearance : "system";
    const root = document.documentElement;
    const apply = () => {
      const dark = isDark(value);
      root.classList.toggle("dark", dark);
    };
    apply();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    root.dataset.density = density;
    root.dataset.reducedMotion = String(reducedMotion);

    return () => media.removeEventListener("change", apply);
  }, [appearance, density, reducedMotion]);

  return children;
}
