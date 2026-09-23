import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { ArrowLeft, ClipboardList, LogOut } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { Brand } from "../components/Brand";
import { api } from "../api/client";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Pagination,
  Spinner,
  StatusBadge,
} from "../components/legacy-ui";
import { SubmissionEditor } from "../forms/SubmissionEditor";
import { canSubmitToForm } from "../forms/capabilities";
import { stateLabel, stateTone } from "../forms/formStatus";
import type { FormRecord } from "../api/types";

// FormsPortalShell is the lightweight authenticated wrapper for the Forms portal — deliberately
// outside the full operator sidebar. It reuses the same auth gate as the operator shell but shows a
// minimal chrome so submitters get a focused experience.
export function FormsPortalShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (!auth.isLoading && !auth.status?.authenticated) {
      void navigate(
        auth.status?.setupRequired
          ? "/setup"
          : `/login?returnTo=${encodeURIComponent(location.pathname)}`,
        { replace: true },
      );
    }
  }, [auth.isLoading, auth.status, navigate, location.pathname]);
  if (auth.isLoading || !auth.status?.authenticated) return null;
  return (
    <div className="forms-portal">
      <header className="forms-portal__topbar">
        <Link to="/forms" className="forms-portal__brand" aria-label="My Forms">
          <Brand compact />
          <span className="forms-portal__brand-label">Forms</span>
        </Link>
        <div className="forms-portal__topbar-actions">
          <Link to="/" className="text-link">
            <ArrowLeft size={16} aria-hidden="true" /> Back to Studio
          </Link>
          <button
            type="button"
            className="text-link"
            onClick={() => void auth.logout()}
            disabled={auth.isSubmitting}
          >
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      </header>
      <main className="forms-portal__content">
        <Outlet />
      </main>
    </div>
  );
}

// FormsListPage lists every form the user can access with their capability and submission counts.
export function FormsListPage() {
  const forms = useQuery({ queryKey: ["forms"], queryFn: api.listForms });

  if (forms.isLoading) return <Spinner label="Loading your forms…" />;
  if (forms.isError) {
    return (
      <Notice variant="danger" title="Could not load forms">
        {forms.error instanceof Error
          ? forms.error.message
          : "Please try again."}
      </Notice>
    );
  }
  const items = forms.data ?? [];
  return (
    <div className="forms-portal__list">
      <PageHeader
        eyebrow="Forms"
        title="My Forms"
        description="Forms you can submit to or help review."
      />
      {items.length === 0 ? (
        <EmptyState
          icon={<ClipboardList size={28} aria-hidden="true" />}
          title="No forms yet"
          message="You do not have access to any forms. Ask an administrator to grant you access."
        />
      ) : (
        <ul className="forms-portal__cards">
          {items.map((form) => (
            <li key={form.id}>
              <Link to={`/forms/${form.id}`} className="forms-portal__card">
                <div className="forms-portal__card-head">
                  <h2>{form.name}</h2>
                  {form.publishedRevisionNumber === undefined && (
                    <StatusBadge label="Draft only" tone="neutral" />
                  )}
                </div>
                {form.description && <p>{form.description}</p>}
                <dl className="forms-portal__counts">
                  <div>
                    <dt>Drafts</dt>
                    <dd>{form.submissionCounts.draft}</dd>
                  </div>
                  <div>
                    <dt>Submitted</dt>
                    <dd>{form.submissionCounts.submitted}</dd>
                  </div>
                  <div>
                    <dt>Changes requested</dt>
                    <dd>{form.submissionCounts.changesRequested}</dd>
                  </div>
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// FormPortalDetailPage shows the published form, a Start submission action, and the user's own
// submissions with status.
const MINE_PAGE_SIZE = 20;

export function FormPortalDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [page, setPage] = useState(1);
  // A completed submission returns here carrying router state, so the submitter gets explicit
  // confirmation it landed instead of a silent bounce back to the list. The flag is copied into local
  // state and stripped from history immediately so a reload does not re-announce it.
  const [justSubmitted] = useState(
    () =>
      (location.state as { submitted?: boolean } | null)?.submitted === true,
  );
  useEffect(() => {
    if (justSubmitted) {
      void navigate(location.pathname, { replace: true, state: null });
    }
  }, [justSubmitted, navigate, location.pathname]);
  const form = useQuery({
    queryKey: ["form-data-source", id],
    queryFn: () => api.getForm(id!),
    enabled: Boolean(id),
  });
  // "Your submissions" is scoped and paginated server-side (mine=true) rather than fetching every
  // visible record and filtering in React.
  const records = useQuery({
    queryKey: ["form-records", id, "mine", page],
    queryFn: () =>
      api.listFormRecords(id!, {
        mine: true,
        sort: "updated",
        page,
        pageSize: MINE_PAGE_SIZE,
      }),
    enabled: Boolean(id),
  });

  if (form.isLoading) return <Spinner label="Loading form…" />;
  if (form.isError || !form.data) {
    return (
      <Notice variant="danger" title="Form unavailable">
        You may not have access to this form, or it no longer exists.{" "}
        <Link to="/forms" className="text-link">
          Back to My Forms
        </Link>
      </Notice>
    );
  }
  const detail = form.data;
  const published = detail.publishedRevision;
  const canSubmit = canSubmitToForm(detail.grantedCapabilities);
  const mine = records.data?.items ?? [];
  const total = records.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / MINE_PAGE_SIZE));

  return (
    <div className="forms-portal__detail">
      <PageHeader
        eyebrow="Form"
        title={published?.title || detail.name}
        description={published?.description || detail.description}
        actions={
          canSubmit && published ? (
            <Link to={`/forms/${detail.id}/new`}>
              <Button variant="primary">Start submission</Button>
            </Link>
          ) : undefined
        }
      />

      {justSubmitted && (
        <Notice variant="success" title="Submission sent">
          Your submission is now with the reviewers. You can follow its status
          below.
        </Notice>
      )}

      {!published && (
        <Notice variant="info" title="Not open for submissions yet">
          This form has not published a version you can submit to.
        </Notice>
      )}
      {published && !canSubmit && (
        <Notice variant="info" title="View only">
          You can review submissions to this form but cannot create your own.
        </Notice>
      )}

      <section
        aria-label="Your submissions"
        className="forms-portal__submissions"
      >
        <h2>Your submissions</h2>
        {records.isLoading ? (
          <Spinner label="Loading submissions…" />
        ) : mine.length === 0 ? (
          <EmptyState
            title="No submissions yet"
            message={
              canSubmit && published
                ? "Start a submission to see it here."
                : "You have not submitted to this form."
            }
          />
        ) : (
          <>
            <ul className="forms-portal__submission-list">
              {mine.map((record) => (
                <SubmissionRow
                  key={record.id}
                  formId={detail.id}
                  record={record}
                  workflow={detail.workflow}
                />
              ))}
            </ul>
            {totalPages > 1 && (
              <Pagination
                label="Your submissions pages"
                status={`Page ${page} of ${totalPages} · ${total} total`}
                previous={() => setPage((current) => Math.max(1, current - 1))}
                next={() =>
                  setPage((current) => Math.min(totalPages, current + 1))
                }
                previousDisabled={page <= 1}
                nextDisabled={page >= totalPages}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

function SubmissionRow({
  formId,
  record,
  workflow,
}: {
  formId: string;
  record: FormRecord;
  workflow: import("../api/types").FormWorkflow;
}) {
  return (
    <li>
      <Link
        to={`/forms/${formId}/submissions/${record.id}`}
        className="forms-portal__submission"
      >
        <span className="forms-portal__submission-title">
          {record.displayTitle || "Untitled submission"}
        </span>
        <StatusBadge
          label={stateLabel(workflow, record.state)}
          tone={stateTone(workflow, record.state)}
        />
        <span className="forms-portal__submission-time">
          Updated {new Date(record.updatedAt).toLocaleString()}
        </span>
      </Link>
    </li>
  );
}

// FormPortalSubmissionPage hosts the submission editor for a new or existing submission.
export function FormPortalSubmissionPage() {
  const { id, recordId } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const csrf = auth.status?.csrfToken ?? "";
  const form = useQuery({
    queryKey: ["form-data-source", id],
    queryFn: () => api.getForm(id!),
    enabled: Boolean(id),
  });
  const record = useQuery({
    queryKey: ["form-record", id, recordId],
    queryFn: () => api.getFormRecord(id!, recordId!),
    enabled: Boolean(id) && Boolean(recordId),
  });

  if (form.isLoading || (recordId && record.isLoading)) {
    return <Spinner label="Loading…" />;
  }
  if (form.isError || !form.data) {
    return (
      <Notice variant="danger" title="Form unavailable">
        <Link to="/forms" className="text-link">
          Back to My Forms
        </Link>
      </Notice>
    );
  }
  if (recordId && (record.isError || !record.data)) {
    return (
      <Notice variant="danger" title="Submission unavailable">
        You may not have access to this submission.{" "}
        <Link to={`/forms/${id}`} className="text-link">
          Back to the form
        </Link>
      </Notice>
    );
  }

  return (
    <div className="forms-portal__editor">
      <PageHeader
        eyebrow={form.data.publishedRevision?.title || form.data.name}
        title={recordId ? "Edit submission" : "New submission"}
        actions={
          <Link to={`/forms/${id}`}>
            <Button variant="quiet">
              <ArrowLeft size={16} aria-hidden="true" /> Back
            </Button>
          </Link>
        }
      />
      <SubmissionEditor
        form={form.data}
        initialDetail={recordId ? record.data : undefined}
        csrf={csrf}
        onCompleted={() =>
          void navigate(`/forms/${id}`, { state: { submitted: true } })
        }
      />
    </div>
  );
}
