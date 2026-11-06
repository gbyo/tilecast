import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FontFamily } from "../api/types";
import { fontQueries } from "../data/fonts";

/**
 * Studio draws library fonts under the same generated family name the
 * Player Runtime uses (`tcf-<id>`), so a family name typed by a person
 * never becomes CSS text and the editor matches the screen.
 */
export function libraryFamilyName(fontId: string): string {
  return `tcf-${fontId.toLowerCase()}`;
}

const registered = new Map<string, Promise<void>>();

function addFace(
  key: string,
  family: string,
  source: string,
  descriptors: FontFaceDescriptors,
): Promise<void> {
  const existing = registered.get(key);
  if (existing) return existing;
  if (typeof FontFace === "undefined" || typeof document === "undefined")
    return Promise.resolve();
  let loading: Promise<void>;
  try {
    const face = new FontFace(family, `url("${source}")`, descriptors);
    (document.fonts as unknown as { add(face: FontFace): void }).add(face);
    loading = face.load().then(
      () => undefined,
      () => {
        registered.delete(key);
      },
    );
  } catch {
    loading = Promise.resolve();
  }
  registered.set(key, loading);
  return loading;
}

/** Registers every face of the given families in the Studio document. */
export function registerLibraryFonts(
  families: readonly FontFamily[],
): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const family of families) {
    const name = libraryFamilyName(family.id);
    for (const face of family.faces) {
      pending.push(
        addFace(face.id, name, face.fileUrl, {
          weight:
            face.weightMin === face.weightMax
              ? String(face.weightMin)
              : `${face.weightMin} ${face.weightMax}`,
          style: face.style,
          display: "swap",
          ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
        }),
      );
    }
  }
  return Promise.all(pending).then(() => undefined);
}

/**
 * Registers a single preview face by URL, for the catalog browser. The
 * face is named after the catalog family ID so it never collides with a
 * stored library family.
 */
export function registerPreviewFont(
  sourceId: string,
  url: string,
): { family: string; loaded: Promise<void> } {
  const family = `tcp-${sourceId}`;
  return {
    family,
    loaded: addFace(`preview:${sourceId}`, family, url, {
      weight: "400",
      style: "normal",
      display: "swap",
    }),
  };
}

/**
 * The organization font library, with every face registered for drawing.
 * `version` changes when faces finish loading, so callers that measure
 * text can measure again.
 */
export function useLibraryFonts() {
  const query = useQuery(fontQueries.library());
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!query.data?.length) return;
    let active = true;
    void registerLibraryFonts(query.data).then(() => {
      if (active) setVersion((value) => value + 1);
    });
    return () => {
      active = false;
    };
  }, [query.data]);
  return { ...query, families: query.data ?? [], version };
}

/** CSS stack for Layout text: the library family first, then the bundled fallback. */
export function libraryFontStack(
  fontId: string | null | undefined,
  fallbackStack: string,
): string {
  if (!fontId || !FONT_ID.test(fontId)) return fallbackStack;
  return `"${libraryFamilyName(fontId)}", ${fallbackStack}`;
}

const FONT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
