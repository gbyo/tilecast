import type { LayoutPrimitive } from "./api/types";
import { libraryFontStack } from "./fonts/libraryFonts";

export type LayoutFontFamily = NonNullable<LayoutPrimitive["fontFamily"]>;

const layoutFontStacks: Record<LayoutFontFamily, string> = {
  Inter: '"Inter", ui-sans-serif, system-ui, sans-serif',
  Roboto: '"Roboto", ui-sans-serif, system-ui, sans-serif',
  "Source Sans 3": '"Source Sans 3", ui-sans-serif, system-ui, sans-serif',
  "Noto Sans": '"Noto Sans", ui-sans-serif, system-ui, sans-serif',
};

/**
 * A library family (`fontId`) draws first; the bundled family stays the
 * fallback while the face loads and on Players that predate the library.
 */
export function layoutFontStack(
  fontFamily?: string,
  fontId?: string | null,
): string {
  return libraryFontStack(
    fontId,
    layoutFontStacks[fontFamily as LayoutFontFamily] ?? layoutFontStacks.Inter,
  );
}
