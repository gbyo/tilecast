import { apiDelete, apiGet, apiPost } from "./transport";
import { apiErrorFromEnvelope } from "./errors";
import type {
  FontCatalogCategory,
  FontCatalogFamily,
  FontCatalogPage,
  FontFamily,
  FontUploadResult,
  GoogleFontImport,
} from "./types";

export async function listFonts(options?: {
  signal?: AbortSignal;
}): Promise<FontFamily[]> {
  const page = await apiGet("/api/v1/fonts", { signal: options?.signal });
  return page.items;
}

export async function searchFontCatalog(
  query: { q?: string; category?: FontCatalogCategory; offset?: number },
  options?: { signal?: AbortSignal },
): Promise<FontCatalogPage> {
  return await apiGet("/api/v1/fonts/catalog", {
    params: {
      query: {
        ...(query.q ? { q: query.q } : {}),
        ...(query.category ? { category: query.category } : {}),
        limit: 48,
        offset: query.offset ?? 0,
      },
    },
    signal: options?.signal,
  });
}

export async function getFontCatalogFamily(
  sourceId: string,
  options?: { signal?: AbortSignal },
): Promise<FontCatalogFamily> {
  return (await apiGet("/api/v1/fonts/catalog/{sourceId}", {
    params: { path: { sourceId } },
    signal: options?.signal,
  })) as FontCatalogFamily;
}

/** Same-origin preview face; the server fetches it from the catalog. */
export function fontCatalogPreviewUrl(sourceId: string): string {
  return `/api/v1/fonts/catalog/${encodeURIComponent(sourceId)}/preview`;
}

export async function importGoogleFont(
  input: GoogleFontImport,
  csrfToken: string,
): Promise<FontFamily> {
  return await apiPost("/api/v1/fonts/google", {
    body: input,
    csrfToken,
  });
}

/**
 * Multipart upload of one face. Raw fetch is the transport's documented
 * exception for file uploads.
 */
export async function uploadFont(
  file: File,
  rightsConfirmed: boolean,
  csrfToken: string,
): Promise<FontUploadResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("rightsConfirmed", rightsConfirmed ? "true" : "false");
  // architecture-ignore: multipart file upload; the typed transport sends JSON only
  const response = await globalThis.fetch("/api/v1/fonts/uploads", {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-CSRF-Token": csrfToken },
    body: form,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A proxy may replace a bounded API error with a non-JSON response.
  }
  if (!response.ok) throw apiErrorFromEnvelope(body, response.status);
  return (body as { data: FontUploadResult }).data;
}

export function deleteFont(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/fonts/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}
