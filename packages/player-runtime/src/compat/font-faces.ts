/**
 * Organization library fonts for Layout text. The projection names each
 * face with a host-authorized media URI; this module registers it once
 * through the CSS Font Loading API under a generated family name, so a
 * family name from the library never becomes CSS text. The runtime
 * document's `font-src` admits only its own files and `tcmedia:`.
 */

export interface ProjectedFontFace {
  family: string;
  src: string;
  weight: string;
  style: "normal" | "italic";
  unicodeRange?: string;
}

/** `tcf-<uuid>`: the only family names a library face may register. */
export const LIBRARY_FAMILY_PATTERN =
  /^tcf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const WEIGHT_PATTERN = /^[1-9][0-9]{0,3}( [1-9][0-9]{0,3})?$/;
const RANGE_PATTERN =
  /^[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?(\s*,\s*[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?)*$/;
// A granted URI is either a custom-scheme capability (tcmedia:) or a
// same-origin path (the Browser Player). Nothing that could close the
// url() token is accepted.
const SOURCE_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/)[^\s"'()\\]+$/;

export function libraryFamilyName(fontId: string): string {
  return `tcf-${fontId.toLowerCase()}`;
}

export function isProjectedFontFace(
  value: unknown,
): value is ProjectedFontFace {
  if (!value || typeof value !== "object") return false;
  const face = value as Record<string, unknown>;
  return (
    typeof face.family === "string" &&
    LIBRARY_FAMILY_PATTERN.test(face.family) &&
    typeof face.src === "string" &&
    SOURCE_PATTERN.test(face.src) &&
    typeof face.weight === "string" &&
    WEIGHT_PATTERN.test(face.weight) &&
    (face.style === "normal" || face.style === "italic") &&
    (face.unicodeRange === undefined ||
      (typeof face.unicodeRange === "string" &&
        (face.unicodeRange === "" || RANGE_PATTERN.test(face.unicodeRange))))
  );
}

interface FontFaceSetLike {
  add(face: FontFace): unknown;
  delete?(face: FontFace): unknown;
}

const registered = new Map<string, Promise<void>>();

// A library face never changes behind its family ID (removing a family
// and adding it again creates a new ID), so the key leaves out the source.
// Hosts that mint a new capability URI per activation then reuse the face
// that is already loaded instead of adding another one.
function faceKey(face: ProjectedFontFace): string {
  return `${face.family}|${face.weight}|${face.style}|${face.unicodeRange ?? ""}`;
}

/**
 * Registers each valid face once per document and resolves when every face
 * has loaded or failed. A face that fails to load leaves the text on its
 * fallback family; it never fails the presentation.
 */
export function registerFontFaces(
  faces: readonly unknown[],
  fontSet: FontFaceSetLike | undefined = typeof document !== "undefined"
    ? (document.fonts as unknown as FontFaceSetLike)
    : undefined,
): Promise<void> {
  if (!fontSet || typeof FontFace === "undefined") return Promise.resolve();
  const pending: Promise<void>[] = [];
  for (const candidate of faces) {
    if (!isProjectedFontFace(candidate)) continue;
    const key = faceKey(candidate);
    let loading = registered.get(key);
    if (!loading) {
      const descriptors: FontFaceDescriptors = {
        weight: candidate.weight,
        style: candidate.style,
        display: "block",
      };
      if (candidate.unicodeRange)
        descriptors.unicodeRange = candidate.unicodeRange;
      try {
        const face = new FontFace(
          candidate.family,
          `url("${candidate.src}")`,
          descriptors,
        );
        fontSet.add(face);
        loading = face.load().then(
          () => undefined,
          () => {
            // Let a later activation try again with its own grant.
            fontSet.delete?.(face);
            registered.delete(key);
          },
        );
      } catch {
        loading = Promise.resolve();
      }
      registered.set(key, loading);
    }
    pending.push(loading);
  }
  return Promise.all(pending).then(() => undefined);
}

/** Test seam: forget registrations between test documents. */
export function resetRegisteredFontFaces(): void {
  registered.clear();
}
