// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "./ThemeProvider";
import { studioTheme } from "../../pages/Dashboard";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.reducedMotion;
});

describe("Studio appearance and density", () => {
  it("applies saved preferences and changes only presentation when switching density", () => {
    const values = {
      "preference.density": "compact",
      "preference.appearance": "dark",
      "preference.reduced_motion": true,
    };
    const saved = structuredClone(values);
    const { rerender } = render(
      <ThemeProvider {...studioTheme(values)}>
        <button>Resource action</button>
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.reducedMotion).toBe("true");
    const button = screen.getByRole("button", { name: "Resource action" });
    button.focus();
    rerender(
      <ThemeProvider
        {...studioTheme({ ...values, "preference.density": "comfortable" })}
      >
        <button>Resource action</button>
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.density).toBe("comfortable");
    expect(document.activeElement).toBe(button);
    expect(values).toEqual(saved);
  });

  it("defaults absent or invalid density to Comfortable", () => {
    const { rerender } = render(<ThemeProvider>Studio</ThemeProvider>);
    expect(document.documentElement.dataset.density).toBe("comfortable");
    rerender(<ThemeProvider density="unknown">Studio</ThemeProvider>);
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });
});
