/**
 * Schedule, campaign, and editorial-review domain helpers over the typed
 * transport. Schedule CRUD, campaign publication, and editorial action
 * success bodies are contract-typed and inferred from the generated
 * OpenAPI schemas; the handwritten view models in ../types.ts stay for
 * the shapes Studio owns.
 */
import { apiDelete, apiGet, apiPatch, apiPost } from "../transport";
import { fetchAllPages } from "../pagination";
import type { components } from "@tilecast/api-schema/generated/openapi";
import type {
  Campaign,
  CampaignList,
  CampaignPreflight,
  CampaignRelease,
  CampaignSnapshot,
  ContentReviewQueue,
  ContentSubmission,
  ContentSubmissionList,
  EditorialContentType,
  PublicationHistoryItem,
  ScheduleInput,
  ScheduleListParams,
  SchedulePreview,
  SubmissionFilter,
} from "../types";

export function listSchedulesPage(
  filters: Partial<ScheduleListParams> = {},
  page = 1,
) {
  const { search = "", enabled, type, presentationType, sort } = filters;
  return apiGet("/api/v1/schedules", {
    params: {
      query: {
        page,
        pageSize: 100,
        search,
        ...(enabled ? { enabled } : {}),
        ...(type ? { type } : {}),
        ...(presentationType ? { presentationType } : {}),
        ...(sort ? { sort } : {}),
      },
    },
  });
}

/**
 * The organization's default timezone, from a one-row list read. A new
 * schedule starts in it, so the editor needs the value but not the schedules.
 */
export async function getScheduleDefaults() {
  const result = await apiGet("/api/v1/schedules", {
    params: { query: { page: 1, pageSize: 1 } },
  });
  return { defaultTimezone: result.defaultTimezone };
}

export function listSchedules(search = "") {
  return fetchAllPages((page) => listSchedulesPage({ search }, page));
}

export function getSchedule(id: string) {
  return apiGet("/api/v1/schedules/{id}", {
    params: { path: { id } },
  });
}

export function createSchedule(input: ScheduleInput, csrfToken: string) {
  return apiPost("/api/v1/schedules", {
    body: input,
    csrfToken,
  });
}

export function updateSchedule(
  id: string,
  input: ScheduleInput,
  csrfToken: string,
) {
  return apiPatch("/api/v1/schedules/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function deleteSchedule(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/schedules/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function setScheduleEnabled(
  id: string,
  enabled: boolean,
  csrfToken: string,
) {
  const options = { params: { path: { id } }, csrfToken };
  return enabled
    ? apiPost("/api/v1/schedules/{id}/enable", options)
    : apiPost("/api/v1/schedules/{id}/disable", options);
}

export function previewSchedule(
  screenId: string,
  timestamp: string,
  proposedSchedule?: ScheduleInput,
): Promise<SchedulePreview> {
  return apiPost("/api/v1/schedules/preview", {
    body: { screenId, timestamp, proposedSchedule },
  });
}

/**
 * Asks the server how a draft behaves at its next occurrence across every
 * targeted screen. Read-only; scheduleId leaves the saved copy of the draft
 * out of the comparison.
 */
export function preflightSchedule(
  proposedSchedule: ScheduleInput,
  scheduleId?: string,
  signal?: AbortSignal,
) {
  return apiPost("/api/v1/schedules/preflight", {
    body: { proposedSchedule, scheduleId },
    signal,
  });
}

export function listCampaignsPage(
  search = "",
  page = 1,
): Promise<CampaignList> {
  return apiGet("/api/v1/campaigns", {
    params: { query: { page, pageSize: 100, search } },
  });
}

export function listCampaigns(search = ""): Promise<CampaignList> {
  return fetchAllPages((page) => listCampaignsPage(search, page));
}

export function getCampaign(id: string): Promise<Campaign> {
  return apiGet("/api/v1/campaigns/{id}", {
    params: { path: { id } },
  });
}

export function createCampaign(
  input: { name: string; description?: string; timezone?: string },
  csrfToken: string,
): Promise<Campaign> {
  return apiPost("/api/v1/campaigns", { body: input, csrfToken });
}

export function updateCampaignDraft(
  id: string,
  expectedDraftRevision: number,
  draft: CampaignSnapshot,
  csrfToken: string,
): Promise<Campaign> {
  return apiPatch("/api/v1/campaigns/{id}/draft", {
    params: { path: { id } },
    body: { expectedDraftRevision, draft },
    csrfToken,
  });
}

export function getCampaignPreflight(id: string): Promise<CampaignPreflight> {
  return apiGet("/api/v1/campaigns/{id}/preflight", {
    params: { path: { id } },
  });
}

export function listCampaignReleases(id: string): Promise<{
  items: CampaignRelease[];
}> {
  return apiGet("/api/v1/campaigns/{id}/releases", {
    params: { path: { id } },
  });
}

export function restoreCampaignRelease(
  id: string,
  releaseId: string,
  csrfToken: string,
): Promise<Campaign> {
  return apiPost("/api/v1/campaigns/{id}/releases/{releaseId}/restore", {
    params: { path: { id, releaseId } },
    csrfToken,
  });
}

/**
 * Wire shapes of publication results from the generated contract: a
 * publish answers 201 with the publication record or 202 with the review
 * submission it created instead.
 */
export type WirePublicationResult =
  | components["schemas"]["ContentSubmissionPublication"]
  | components["schemas"]["ContentSubmission"];

export function publishCampaign(
  id: string,
  expectedDraftRevision: number,
  csrfToken: string,
): Promise<WirePublicationResult> {
  return apiPost("/api/v1/campaigns/{id}/publish", {
    params: { path: { id } },
    body: { expectedDraftRevision },
    csrfToken,
  });
}

export function archiveCampaign(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/campaigns/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function scheduleContentSubmission(
  id: string,
  requestedPublicationAt: string,
  csrfToken: string,
): Promise<ContentSubmission> {
  return apiPost("/api/v1/content-submissions/{id}/schedule", {
    params: { path: { id } },
    body: { requestedPublicationAt },
    csrfToken,
  });
}

export function cancelContentSchedule(
  id: string,
  csrfToken: string,
): Promise<ContentSubmission> {
  return apiPost("/api/v1/content-submissions/{id}/cancel-schedule", {
    params: { path: { id } },
    csrfToken,
  });
}

export function listPublicationHistory(
  contentType: EditorialContentType,
  id: string,
): Promise<{ items: PublicationHistoryItem[] }> {
  return apiGet("/api/v1/content-history/{type}/{id}/publications", {
    params: { path: { type: contentType, id } },
  });
}

export function listContentReviews(state = ""): Promise<ContentReviewQueue> {
  return apiGet("/api/v1/content-reviews", {
    params: { query: state ? { state } : {} },
  });
}

export function decideContentReview(
  contentType: "playlist" | "layout",
  id: string,
  body: { approve: boolean; note?: string; revision?: number },
  csrfToken: string,
) {
  return apiPost("/api/v1/content-reviews/{type}/{id}", {
    params: { path: { type: contentType, id } },
    body,
    csrfToken,
  });
}

export function listContentSubmissions(
  state: SubmissionFilter = "",
): Promise<ContentSubmissionList> {
  return apiGet("/api/v1/content-submissions", {
    params: { query: state ? { state } : {} },
  });
}

export function getContentSubmission(id: string): Promise<ContentSubmission> {
  return apiGet("/api/v1/content-submissions/{id}", {
    params: { path: { id } },
  });
}

export function submitContent(
  contentType: EditorialContentType,
  id: string,
  csrfToken: string,
  requestedPublicationAt?: string,
  expectedRevision?: number,
): Promise<ContentSubmission> {
  return apiPost("/api/v1/content-submissions/{type}/{id}", {
    params: { path: { type: contentType, id } },
    body: { requestedPublicationAt, expectedRevision },
    csrfToken,
  });
}

export function approveContentSubmission(
  id: string,
  note: string,
  csrfToken: string,
): Promise<ContentSubmission> {
  return apiPost("/api/v1/content-submissions/{id}/approve", {
    params: { path: { id } },
    body: { note },
    csrfToken,
  });
}

export function requestContentChanges(
  id: string,
  note: string,
  csrfToken: string,
): Promise<ContentSubmission> {
  return apiPost("/api/v1/content-submissions/{id}/request-changes", {
    params: { path: { id } },
    body: { note },
    csrfToken,
  });
}

export function publishContentSubmission(
  id: string,
  csrfToken: string,
): Promise<components["schemas"]["ContentSubmissionPublication"]> {
  // The server publishes from the path id alone and reads no body.
  return apiPost("/api/v1/content-submissions/{id}/publish", {
    params: { path: { id } },
    csrfToken,
  });
}

export function restorePublicationToDraft(
  contentType: EditorialContentType,
  contentId: string,
  publicationId: string,
  csrfToken: string,
): Promise<components["schemas"]["EditorialSnapshot"]> {
  return apiPost(
    "/api/v1/content-history/{type}/{id}/publications/{publicationId}/restore-draft",
    {
      params: { path: { type: contentType, id: contentId, publicationId } },
      csrfToken,
    },
  );
}

export function rollbackPublication(
  contentType: EditorialContentType,
  contentId: string,
  publicationId: string,
  csrfToken: string,
): Promise<components["schemas"]["ContentSubmissionPublication"]> {
  return apiPost(
    "/api/v1/content-history/{type}/{id}/publications/{publicationId}/rollback",
    {
      params: { path: { type: contentType, id: contentId, publicationId } },
      csrfToken,
    },
  );
}

export function comparePublications(
  contentType: EditorialContentType,
  id: string,
  fromPublicationId: string,
  toPublicationId: string,
): Promise<{
  changed: boolean;
  changes: { kind: string; path: string; description: string }[];
}> {
  return apiGet("/api/v1/content-history/{type}/{id}/compare", {
    params: {
      path: { type: contentType, id },
      query: { fromPublicationId, toPublicationId },
    },
  });
}
