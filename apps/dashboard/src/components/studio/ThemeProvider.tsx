import { useEffect, type ReactNode } from "react";
import { studioDensity } from "./density";

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
    // Cache the resolved choice so the first-paint script in index.html can
    // apply it before React loads; otherwise a refresh flashes the system theme.
    try {
      window.localStorage.setItem("tilecast.appearance", value);
    } catch {
      // The server preference still applies when storage is unavailable.
    }
    const apply = () => {
      const dark = isDark(value);
      root.classList.toggle("dark", dark);
    };
    apply();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    root.dataset.density = studioDensity(density);
    root.dataset.reducedMotion = String(reducedMotion);

    return () => media.removeEventListener("change", apply);
  }, [appearance, density, reducedMotion]);

  return children;
}
