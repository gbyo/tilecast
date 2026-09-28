/**
 * Forms plugin HTTP client. Plugin-local DTOs come from ./types.ts and every
 * request goes through studioRequest, so no central dashboard API surface is
 * needed to render Forms pages.
 */
import { ApiError, studioRequest } from "@tilecast/studio";
import type {
  CreateFormInput,
  FormAccessEntry,
  FormApprovalPage,
  FormDataSource,
  FormSummary,
  FormDirectoryUser,
  FormMetadataInput,
  FormOutputs,
  FormRecord,
  FormRecordComment,
  FormRecordDetail,
  FormRecordInput,
  FormRecordListParams,
  FormRecordPage,
  FormRevision,
  FormSchema,
  FormTypedDataset,
  FormView,
  FormViewInput,
  FormWorkflow,
} from "./types";

// formRecordBody serializes a record create/update body honoring the server's tri-state contract:
// a field left `undefined` is omitted (preserve), `null` is sent as null (clear), and any other
// value is sent as-is (set).
function formRecordBody(input: FormRecordInput): string {
  const body: Record<string, unknown> = { values: input.values };
  if (input.displayTitle !== undefined) body.displayTitle = input.displayTitle;
  if (input.priority !== undefined) body.priority = input.priority;
  if (input.displayAt !== undefined) body.displayAt = input.displayAt;
  if (input.expiresAt !== undefined) body.expiresAt = input.expiresAt;
  if (input.version !== undefined) body.version = input.version;
  return JSON.stringify(body);
}

// readFileAsBase64 returns the base64 payload of a File (without the data: URL prefix), for the
// JSON attachment upload endpoint.
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () =>
      reject(
        new ApiError(
          "Could not read the selected file.",
          0,
          "file_read_failed",
        ),
      );
    reader.readAsDataURL(file);
  });
}

// formRecordQuery builds the query string for the paginated records list.
function formRecordQuery(params: FormRecordListParams = {}): string {
  const query = new URLSearchParams();
  if (params.states && params.states.length > 0)
    query.set("states", params.states.join(","));
  if (params.search) query.set("search", params.search);
  if (params.sort) query.set("sort", params.sort);
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export const formsApi = {
  // Form Data Sources. Creation is a dedicated endpoint; the detail, metadata, draft, and
  // publish operations are namespaced under the parent Data Source id.
  createForm: (input: CreateFormInput, csrfToken: string) =>
    studioRequest<FormDataSource>("/forms", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  getForm: (id: string) =>
    studioRequest<FormDataSource>(`/data-sources/${id}/form`),
  updateFormMetadata: (
    id: string,
    input: FormMetadataInput,
    csrfToken: string,
  ) =>
    studioRequest<FormDataSource>(`/data-sources/${id}/form`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateFormDraft: (id: string, schema: FormSchema, csrfToken: string) =>
    studioRequest<FormDataSource>(`/data-sources/${id}/form/draft`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ schema }),
    }),
  publishForm: (id: string, csrfToken: string) =>
    studioRequest<FormRevision>(`/data-sources/${id}/form/publish`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  // Accessible forms for the Forms portal and navigation.
  listForms: () =>
    studioRequest<{ items: FormSummary[] }>("/forms").then(
      (result) => result.items,
    ),
  // Records / submissions.
  listFormRecords: (id: string, params?: FormRecordListParams) =>
    studioRequest<FormRecordPage>(
      `/data-sources/${id}/records${formRecordQuery(params)}`,
    ),
  getFormRecord: (id: string, recordId: string) =>
    studioRequest<FormRecordDetail>(`/data-sources/${id}/records/${recordId}`),
  createFormRecord: (id: string, input: FormRecordInput, csrfToken: string) =>
    studioRequest<FormRecord>(`/data-sources/${id}/records`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: formRecordBody(input),
    }),
  updateFormRecord: (
    id: string,
    recordId: string,
    input: FormRecordInput,
    csrfToken: string,
  ) =>
    studioRequest<FormRecord>(`/data-sources/${id}/records/${recordId}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: formRecordBody(input),
    }),
  deleteFormRecord: (id: string, recordId: string, csrfToken: string) =>
    studioRequest<void>(`/data-sources/${id}/records/${recordId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  transitionFormRecord: (
    id: string,
    recordId: string,
    input: { toState: string; note?: string; version: number },
    csrfToken: string,
  ) =>
    studioRequest<FormRecord>(
      `/data-sources/${id}/records/${recordId}/transitions`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify(input),
      },
    ),
  addFormRecordComment: (
    id: string,
    recordId: string,
    body: string,
    csrfToken: string,
  ) =>
    studioRequest<FormRecordComment>(
      `/data-sources/${id}/records/${recordId}/comments`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ body }),
      },
    ),
  // Attachments. Upload/replace and remove return the updated record detail.
  // Attachment upload/removal use optimistic concurrency: the caller passes the record's current
  // version, and the returned detail carries the incremented version to use for the next action.
  uploadFormRecordAttachment: async (
    id: string,
    recordId: string,
    file: File,
    fieldKey: string,
    version: number,
    csrfToken: string,
  ) => {
    const data = await readFileAsBase64(file);
    return studioRequest<FormRecordDetail>(
      `/data-sources/${id}/records/${recordId}/attachments`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({
          fieldKey,
          fileName: file.name,
          contentType: file.type,
          data,
          version,
        }),
      },
    );
  },
  removeFormRecordAttachment: (
    id: string,
    recordId: string,
    attachmentId: string,
    version: number,
    csrfToken: string,
  ) =>
    studioRequest<FormRecordDetail>(
      `/data-sources/${id}/records/${recordId}/attachments/${attachmentId}?version=${version}`,
      { method: "DELETE", headers: { "X-CSRF-Token": csrfToken } },
    ),
  // The stable URL for a record's attachment image (served with session credentials).
  formAttachmentContentUrl: (
    id: string,
    recordId: string,
    attachmentId: string,
  ) =>
    `/api/v1/data-sources/${id}/records/${recordId}/attachments/${attachmentId}/content`,
  // Workflow, views, outputs, and access (Studio 2C).
  configureFormWorkflow: (
    id: string,
    workflow: FormWorkflow,
    csrfToken: string,
  ) =>
    studioRequest<FormDataSource>(`/data-sources/${id}/form/workflow`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(workflow),
    }),
  upsertFormView: (id: string, input: FormViewInput, csrfToken: string) =>
    studioRequest<FormView>(`/data-sources/${id}/views`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  previewFormView: (id: string, input: FormViewInput, csrfToken: string) =>
    studioRequest<FormTypedDataset>(`/data-sources/${id}/views/preview`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deleteFormView: (id: string, viewId: string, csrfToken: string) =>
    studioRequest<void>(`/data-sources/${id}/views/${viewId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  getFormOutputs: (id: string) =>
    studioRequest<FormOutputs>(`/data-sources/${id}/outputs`),
  rebuildFormOutputs: (id: string, csrfToken: string) =>
    studioRequest<FormOutputs>(`/data-sources/${id}/outputs/rebuild`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  listFormAccess: (id: string) =>
    studioRequest<{ entries: FormAccessEntry[] }>(
      `/data-sources/${id}/access`,
    ).then((result) => result.entries),
  replaceFormGrants: (
    id: string,
    userId: string,
    capabilities: string[],
    csrfToken: string,
  ) =>
    studioRequest<{ entries: FormAccessEntry[] }>(
      `/data-sources/${id}/access/${userId}`,
      {
        method: "PUT",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ capabilities }),
      },
    ).then((result) => result.entries),
  searchFormUsers: (id: string, search: string) => {
    const query = new URLSearchParams();
    if (search) query.set("search", search);
    const encoded = query.toString();
    return studioRequest<{ items: FormDirectoryUser[] }>(
      `/data-sources/${id}/user-directory${encoded ? `?${encoded}` : ""}`,
    ).then((result) => result.items);
  },
  // Central approvals inbox.
  listApprovals: (params?: { page?: number; pageSize?: number }) => {
    const query = new URLSearchParams();
    if (params?.page) query.set("page", String(params.page));
    if (params?.pageSize) query.set("pageSize", String(params.pageSize));
    const encoded = query.toString();
    return studioRequest<FormApprovalPage>(
      `/approvals${encoded ? `?${encoded}` : ""}`,
    );
  },
};
