/**
 * Schedule, campaign, and editorial-review domain helpers over the typed
 * transport. Schedule CRUD success bodies are contract-typed and
 * inferred from the generated OpenAPI schemas; campaigns, reviews,
 * and the schedule preview still state their local Studio response
 * type explicitly until the contract gains schemas.
 */
import { apiDelete, apiGet, apiPatch, apiPost } from "../transport";
import type {
  Campaign,
  CampaignList,
  CampaignPreflight,
  CampaignRelease,
  CampaignSnapshot,
  ContentReview,
  ContentReviewQueue,
  ContentSubmission,
  ContentSubmissionList,
  EditorialContentType,
  PublicationHistoryItem,
  ScheduleInput,
  SchedulePreview,
  SubmissionFilter,
} from "../types";

export function listSchedules(search = "") {
  return apiGet("/api/v1/schedules", {
    params: { query: { page: 1, pageSize: 100, search } },
  });
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
  return apiPost<"/api/v1/schedules/preview", SchedulePreview>(
    "/api/v1/schedules/preview",
    { body: { screenId, timestamp, proposedSchedule } },
  );
}

export function listCampaigns(search = ""): Promise<CampaignList> {
  return apiGet<"/api/v1/campaigns", CampaignList>("/api/v1/campaigns", {
    params: { query: { page: 1, pageSize: 100, search } },
  });
}

export function getCampaign(id: string): Promise<Campaign> {
  return apiGet<"/api/v1/campaigns/{id}", Campaign>("/api/v1/campaigns/{id}", {
    params: { path: { id } },
  });
}

export function createCampaign(
  input: { name: string; description?: string; timezone?: string },
  csrfToken: string,
): Promise<Campaign> {
  return apiPost<"/api/v1/campaigns", Campaign>("/api/v1/campaigns", {
    body: input,
    csrfToken,
  });
}

export function updateCampaignDraft(
  id: string,
  expectedDraftRevision: number,
  draft: CampaignSnapshot,
  csrfToken: string,
): Promise<Campaign> {
  return apiPatch<"/api/v1/campaigns/{id}/draft", Campaign>(
    "/api/v1/campaigns/{id}/draft",
    {
      params: { path: { id } },
      body: { expectedDraftRevision, draft },
      csrfToken,
    },
  );
}

export function getCampaignPreflight(id: string): Promise<CampaignPreflight> {
  return apiGet<"/api/v1/campaigns/{id}/preflight", CampaignPreflight>(
    "/api/v1/campaigns/{id}/preflight",
    { params: { path: { id } } },
  );
}

export function listCampaignReleases(id: string): Promise<{
  items: CampaignRelease[];
}> {
  return apiGet<
    "/api/v1/campaigns/{id}/releases",
    { items: CampaignRelease[] }
  >("/api/v1/campaigns/{id}/releases", { params: { path: { id } } });
}

export function restoreCampaignRelease(
  id: string,
  releaseId: string,
  csrfToken: string,
): Promise<Campaign> {
  return apiPost<
    "/api/v1/campaigns/{id}/releases/{releaseId}/restore",
    Campaign
  >("/api/v1/campaigns/{id}/releases/{releaseId}/restore", {
    params: { path: { id, releaseId } },
    csrfToken,
  });
}

export function publishCampaign(
  id: string,
  expectedDraftRevision: number,
  csrfToken: string,
): Promise<unknown> {
  return apiPost<"/api/v1/campaigns/{id}/publish", unknown>(
    "/api/v1/campaigns/{id}/publish",
    { params: { path: { id } }, body: { expectedDraftRevision }, csrfToken },
  );
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
  return apiGet<
    "/api/v1/content-history/{type}/{id}/publications",
    { items: PublicationHistoryItem[] }
  >("/api/v1/content-history/{type}/{id}/publications", {
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
): Promise<ContentReview> {
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
): Promise<unknown> {
  // The server publishes from the path id alone and reads no body.
  return apiPost<"/api/v1/content-submissions/{id}/publish", unknown>(
    "/api/v1/content-submissions/{id}/publish",
    { params: { path: { id } }, csrfToken },
  );
}

export function restorePublicationToDraft(
  contentType: EditorialContentType,
  contentId: string,
  publicationId: string,
  csrfToken: string,
): Promise<unknown> {
  return apiPost<
    "/api/v1/content-history/{type}/{id}/publications/{publicationId}/restore-draft",
    unknown
  >(
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
): Promise<unknown> {
  return apiPost<
    "/api/v1/content-history/{type}/{id}/publications/{publicationId}/rollback",
    unknown
  >(
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
  return apiGet<
    "/api/v1/content-history/{type}/{id}/compare",
    {
      changed: boolean;
      changes: { kind: string; path: string; description: string }[];
    }
  >("/api/v1/content-history/{type}/{id}/compare", {
    params: {
      path: { type: contentType, id },
      query: { fromPublicationId, toPublicationId },
    },
  });
}
