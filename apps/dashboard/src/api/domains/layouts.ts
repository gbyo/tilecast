/**
 * Layout domain helpers over the typed transport. Path, query, and body
 * shapes come from the generated OpenAPI contract; the handwritten view
 * models in ../types.ts stay, with the layout normalizers bridging wire
 * and view shapes. Blob preview uploads stay on raw fetch: image
 * acquisition is an explicitly exceptional transport.
 */
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../transport";
import type {
  Layout,
  LayoutDocument,
  LayoutList,
  LayoutOrientation,
  LayoutRevision,
  LayoutRevisionList,
} from "../types";

function normalizeLayoutDocument(
  document: LayoutDocument | null | undefined,
  layout: Pick<Layout, "orientation" | "canvasWidth" | "canvasHeight">,
): LayoutDocument {
  const fallback: LayoutDocument = {
    schemaVersion: 2,
    canvas: {
      width: layout.canvasWidth,
      height: layout.canvasHeight,
      orientation: layout.orientation,
      backgroundColor: "#0E141B",
      safeAreaPercent: 5,
    },
    placements: [],
  };
  if (!document) return fallback;
  return {
    ...document,
    schemaVersion: document.schemaVersion ?? fallback.schemaVersion,
    canvas: { ...fallback.canvas, ...(document.canvas ?? {}) },
    placements: Array.isArray(document.placements) ? document.placements : [],
  };
}

export function normalizeLayout(layout: Layout | null | undefined): Layout {
  const source = layout ?? ({} as Layout);
  return {
    ...source,
    draft: normalizeLayoutDocument(source.draft, source),
    dependencies: Array.isArray(source.dependencies) ? source.dependencies : [],
    usage: {
      screens: Array.isArray(source.usage?.screens) ? source.usage.screens : [],
      schedules: Array.isArray(source.usage?.schedules)
        ? source.usage.schedules
        : [],
      campaigns: Array.isArray(source.usage?.campaigns)
        ? source.usage.campaigns
        : [],
    },
  };
}

export function normalizeLayoutList(
  result: LayoutList | null | undefined,
): LayoutList {
  const source = result ?? ({} as LayoutList);
  return {
    ...source,
    items: Array.isArray(source.items) ? source.items : [],
  };
}

const PAGE_SIZE = 100;

export async function listLayouts(search = ""): Promise<LayoutList> {
  const result = normalizeLayoutList(
    await apiGet("/api/v1/layouts", {
      params: { query: { search, page: 1, pageSize: PAGE_SIZE } },
    }),
  );
  const pageCount = Math.ceil(result.total / PAGE_SIZE);
  if (pageCount <= 1) return result;

  const remainingPages = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      apiGet("/api/v1/layouts", {
        params: {
          query: { search, page: index + 2, pageSize: PAGE_SIZE },
        },
      }).then(normalizeLayoutList),
    ),
  );
  return {
    ...result,
    items: [result, ...remainingPages].flatMap((page) => page.items),
  };
}

export async function getLayout(id: string): Promise<Layout> {
  return normalizeLayout(
    await apiGet("/api/v1/layouts/{id}", { params: { path: { id } } }),
  );
}

export async function createLayout(
  input: {
    name: string;
    description: string;
    orientation: LayoutOrientation;
    canvasWidth: number;
    canvasHeight: number;
  },
  csrfToken: string,
): Promise<Layout> {
  return normalizeLayout(
    await apiPost("/api/v1/layouts", { body: input, csrfToken }),
  );
}

export async function updateLayout(
  id: string,
  input: { name: string; description: string },
  csrfToken: string,
): Promise<Layout> {
  return normalizeLayout(
    await apiPatch("/api/v1/layouts/{id}", {
      params: { path: { id } },
      body: input,
      csrfToken,
    }),
  );
}

export async function saveLayoutDraft(
  id: string,
  expectedDraftRevision: number,
  document: LayoutDocument,
  csrfToken: string,
): Promise<Layout> {
  return normalizeLayout(
    await apiPut("/api/v1/layouts/{id}/draft", {
      params: { path: { id } },
      body: { expectedDraftRevision, document },
      csrfToken,
    }),
  );
}

export function publishLayout(
  id: string,
  expectedDraftRevision: number,
  csrfToken: string,
): Promise<LayoutRevision> {
  return apiPost<"/api/v1/layouts/{id}/publish", LayoutRevision>(
    "/api/v1/layouts/{id}/publish",
    {
      params: { path: { id } },
      body: { expectedDraftRevision },
      csrfToken,
    },
  );
}

export async function duplicateLayout(
  id: string,
  csrfToken: string,
): Promise<Layout> {
  return normalizeLayout(
    await apiPost("/api/v1/layouts/{id}/duplicate", {
      params: { path: { id } },
      csrfToken,
    }),
  );
}

export function deleteLayout(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/layouts/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function listLayoutRevisions(id: string): Promise<LayoutRevisionList> {
  return apiGet("/api/v1/layouts/{id}/revisions", {
    params: { path: { id }, query: { page: 1, pageSize: PAGE_SIZE } },
  });
}

export async function restoreLayoutRevision(
  id: string,
  revisionId: string,
  expectedDraftRevision: number,
  csrfToken: string,
): Promise<Layout> {
  return normalizeLayout(
    await apiPost("/api/v1/layouts/{id}/revisions/{revisionId}/restore", {
      params: { path: { id, revisionId } },
      body: { expectedDraftRevision },
      csrfToken,
    }),
  );
}
