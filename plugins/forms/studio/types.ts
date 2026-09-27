/**
 * Forms plugin DTOs. These mirror the plugin server's JSON contracts in
 * plugins/forms/server; Studio consumes them only through ./api.ts.
 * FormCapability and the nav-visible FormSummary intentionally also exist in
 * apps/dashboard/src/api/types.ts: the sidebar Approvals entry reads them
 * through the central client without importing plugin code.
 */
// --- Form Data Sources ---
// These mirror the server JSON contracts in apps/server/internal/forms/types.go.

export type FormCapability =
  "manage" | "submit" | "view_own" | "view_all" | "review" | "approve";

export type FormFieldControl =
  | "short_text"
  | "long_text"
  | "number"
  | "integer"
  | "boolean"
  | "select"
  | "multi_select"
  | "date"
  | "datetime"
  | "url"
  | "image"
  | "section"
  | "help_text";

export type FormSelectOption = { value: string; label: string };

export type FormField = {
  key: string;
  label: string;
  description?: string;
  control: FormFieldControl;
  required?: boolean;
  default?: string;
  options?: FormSelectOption[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

export type FormSchema = {
  title?: string;
  description?: string;
  fields: FormField[];
};

export type FormRevision = {
  id: string;
  dataSourceId: string;
  revisionNumber: number;
  title: string;
  description: string;
  schema: FormSchema;
  publishedAt: string;
};

export type FormWorkflowState = {
  key: string;
  label: string;
  position: number;
  eligibleForOutput: boolean;
  initial: boolean;
  terminal: boolean;
  // Read-only usage decoration from GetForm: how many records are in the state, and whether the
  // state key may still be renamed/removed (false once any record references it).
  recordCount?: number;
  removable?: boolean;
};

export type FormWorkflowTransition = {
  from: string;
  to: string;
  label: string;
  requiredCapability: FormCapability;
  position: number;
};

export type FormWorkflow = {
  states: FormWorkflowState[];
  transitions: FormWorkflowTransition[];
};

export type FormFilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "empty"
  | "not_empty"
  | "greater_than"
  | "less_than";

export type FormSortDirection = "asc" | "desc";

export type FormView = {
  id: string;
  key: string;
  name: string;
  includedStates: string[];
  fieldFilters: {
    field: string;
    operator: FormFilterOperator;
    value: string;
  }[];
  timeFilter: {
    enabled: boolean;
    startField?: string;
    endField?: string;
    startBeforeNow?: boolean;
    endAfterNow?: boolean;
  };
  sort: { field: string; direction: FormSortDirection }[];
  outputFields: string[];
  recordLimit: number;
  position: number;
};

export type FormDataSource = {
  id: string;
  name: string;
  description: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  draftSchema: FormSchema;
  publishedRevision?: FormRevision;
  workflow: FormWorkflow;
  views: FormView[];
  grantedCapabilities: FormCapability[];
};

// --- Studio 2C: views, outputs, access ---

// FormViewInput is the create/update/preview payload for a saved view.
export type FormViewInput = {
  key: string;
  name: string;
  includedStates: string[];
  fieldFilters: {
    field: string;
    operator: FormFilterOperator;
    value: string;
  }[];
  timeFilter: {
    enabled: boolean;
    startField?: string;
    endField?: string;
    startBeforeNow?: boolean;
    endAfterNow?: boolean;
  };
  sort: { field: string; direction: FormSortDirection }[];
  outputFields: string[];
  recordLimit: number;
  position: number;
};

// FormTypedField / FormTypedRecord / FormTypedDataset mirror the server's typed-dataset shapes
// returned by the view preview and the Outputs tab.
export type FormTypedField = { key: string; label: string; type: string };
export type FormTypedRecord = { id: string; values: Record<string, string> };
export type FormTypedDataset = {
  id: string;
  kind: string;
  fields?: FormTypedField[];
  records?: FormTypedRecord[];
};

export type FormOutputUsage = {
  widgets: number;
  layouts: number;
  names: string[];
};

export type FormOutputView = {
  key: string;
  name: string;
  fields: FormTypedField[];
  recordCount: number;
  previewRecords: FormTypedRecord[];
  usage: FormOutputUsage;
};

export type FormOutputs = {
  views: FormOutputView[];
  lastSuccessAt?: string | null;
  nextRefreshAt?: string | null;
  usingCachedData: boolean;
  errorCode?: string | null;
  stale: boolean;
};

export type FormAccessEntry = {
  userId: string;
  name: string;
  username: string;
  role: string;
  capabilities: FormCapability[];
  isCreator: boolean;
  isGlobalOwner: boolean;
};

export type FormDirectoryUser = {
  id: string;
  name: string;
  username: string;
  role: string;
};

export type CreateFormInput = {
  name: string;
  description: string;
  draftSchema: FormSchema;
};

export type FormMetadataInput = { name: string; description: string };

// --- Form submissions, records, approvals (Studio 2B) ---

// SubmissionCounts buckets a user's own submissions by workflow-derived meaning.
export type FormSubmissionCounts = {
  draft: number;
  submitted: number;
  changesRequested: number;
  total: number;
};

// FormSummary is a lightweight accessible-form entry for the Forms portal and navigation.
export type FormSummary = {
  id: string;
  name: string;
  description: string;
  publishedRevisionNumber?: number;
  grantedCapabilities: FormCapability[];
  submissionCounts: FormSubmissionCounts;
};

// FormRecord is one submission row.
export type FormRecord = {
  id: string;
  dataSourceId: string;
  revisionId: string;
  state: string;
  values: Record<string, unknown>;
  submittedBy?: string;
  submitterName: string;
  displayTitle: string;
  priority: number;
  displayAt?: string | null;
  expiresAt?: string | null;
  eligible: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type FormRecordPage = {
  items: FormRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type FormRecordEvent = {
  id: string;
  eventType: string;
  fromState?: string;
  toState?: string;
  actorName?: string;
  note?: string;
  createdAt: string;
};

export type FormRecordComment = {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type FormAttachment = {
  id: string;
  assetId: string;
  fieldKey: string;
};

// FormAvailableTransition is a workflow transition the server has authorized for the viewer.
export type FormAvailableTransition = {
  to: string;
  toLabel: string;
  label: string;
  requiredCapability: FormCapability;
  requiresNote: boolean;
};

// FormRecordDetail is a record decorated server-side with its immutable revision and the exact
// actions the viewer may take, so the UI never re-implements authorization.
export type FormRecordDetail = FormRecord & {
  revision?: FormRevision;
  events: FormRecordEvent[];
  comments: FormRecordComment[];
  attachments: FormAttachment[];
  canEdit: boolean;
  canComment: boolean;
  canDelete: boolean;
  availableTransitions: FormAvailableTransition[];
};

export type FormApprovalItem = {
  recordId: string;
  dataSourceId: string;
  formName: string;
  title: string;
  submitterName: string;
  state: string;
  stateLabel: string;
  displayAt?: string | null;
  expiresAt?: string | null;
  submittedAt: string;
};

export type FormApprovalPage = {
  items: FormApprovalItem[];
  total: number;
  page: number;
  pageSize: number;
};

// Tri-state display-metadata fields for record create/update. `undefined` (omitted) preserves the
// stored value, `null` clears it, and a value sets it — mirroring the server's Optional[T] contract.
export type FormRecordInput = {
  values: Record<string, unknown>;
  displayTitle?: string | null;
  priority?: number | null;
  displayAt?: string | null;
  expiresAt?: string | null;
  version?: number;
};

export type FormRecordListParams = {
  states?: string[];
  search?: string;
  sort?: "newest" | "oldest" | "priority" | "updated";
  // mine scopes the list to the caller's own submissions server-side (used by the Forms portal).
  mine?: boolean;
  page?: number;
  pageSize?: number;
};
