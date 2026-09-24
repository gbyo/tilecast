import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { SubmissionEditor } from "../forms/SubmissionEditor";
import { canSubmitToForm } from "../forms/capabilities";
import { stateLabel, stateTone } from "../forms/formStatus";
import { useFormatLocale } from "../i18n";
import type { FormRecord } from "../api/types";
import type { ReactNode } from "react";

function PortalHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid gap-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {eyebrow}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

function PortalNotice({
  variant,
  title,
  children,
}: {
  variant: "danger" | "success" | "info";
  title: string;
  children: ReactNode;
}) {
  return (
    <Alert
      variant={variant === "danger" ? "destructive" : undefined}
      role={variant === "danger" ? "alert" : "status"}
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function PortalLoading({ label }: { label: string }) {
  const { t } = useTranslation("forms");
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner aria-label={t("portal.loadingIcon")} />
      {label}
    </p>
  );
}

function ToneBadge({ label, tone }: { label: string; tone: string }) {
  const variant =
    tone === "danger"
      ? "destructive"
      : tone === "success"
        ? "default"
        : tone === "warning"
          ? "outline"
          : "secondary";
  return <Badge variant={variant}>{label}</Badge>;
}

function PortalPagination({
  label,
  status,
  previous,
  next,
  previousDisabled,
  nextDisabled,
}: {
  label: string;
  status: string;
  previous: () => void;
  next: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
}) {
  const { t } = useTranslation("forms");
  return (
    <nav className="flex flex-wrap items-center gap-2" aria-label={label}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={previousDisabled}
        onClick={previous}
      >
        {t("portal.previous")}
      </Button>
      <span className="text-sm text-muted-foreground">{status}</span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={nextDisabled}
        onClick={next}
      >
        {t("portal.next")}
      </Button>
    </nav>
  );
}

// FormsPortalShell is the lightweight authenticated wrapper for the Forms portal — deliberately
// outside the full operator sidebar. It reuses the same auth gate as the operator shell but shows a
// minimal chrome so submitters get a focused experience.
export function FormsPortalShell() {
  const { t } = useTranslation("forms");
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
    <div className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-6 py-3">
        <Link
          to="/forms"
          className="flex items-center gap-3 text-inherit no-underline"
          aria-label={t("portal.shell.homeLabel")}
        >
          <Brand compact />
          <span className="font-semibold">{t("portal.shell.formsLabel")}</span>
        </Link>
        <div className="flex items-center gap-5">
          <Link
            to="/"
            className="text-link inline-flex items-center gap-1 no-underline"
          >
            <ArrowLeft size={16} aria-hidden="true" />{" "}
            {t("portal.shell.studioLink")}
          </Link>
          <Button
            type="button"
            variant="link"
            onClick={() => void auth.logout()}
            disabled={auth.isSubmitting}
            className="gap-1 px-0"
          >
            <LogOut size={16} aria-hidden="true" /> {t("portal.shell.signOut")}
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 pt-8 pb-12 max-[700px]:px-4">
        <Outlet />
      </main>
    </div>
  );
}

// FormsListPage lists every form the user can access with their capability and submission counts.
export function FormsListPage() {
  const { t } = useTranslation("forms");
  const forms = useQuery({ queryKey: ["forms"], queryFn: api.listForms });

  if (forms.isLoading)
    return <PortalLoading label={t("portal.list.loading")} />;
  if (forms.isError) {
    return (
      <PortalNotice variant="danger" title={t("portal.list.error")}>
        {forms.error instanceof Error
          ? forms.error.message
          : t("portal.list.retry")}
      </PortalNotice>
    );
  }
  const items = forms.data ?? [];
  return (
    <div className="flex flex-col gap-6">
      <PortalHeader
        eyebrow={t("portal.list.eyebrow")}
        title={t("portal.list.title")}
        description={t("portal.list.description")}
      />
      {items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardList aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("portal.list.empty")}</EmptyTitle>
            <EmptyDescription>{t("portal.list.emptyBody")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="m-0 grid list-none gap-4 p-0 grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]">
          {items.map((form) => (
            <li key={form.id}>
              <Link
                to={`/forms/${form.id}`}
                className="flex h-full flex-col gap-2 rounded-xl border border-border bg-card p-5 text-inherit no-underline transition hover:-translate-y-px hover:border-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="m-0 text-base font-semibold">{form.name}</h2>
                  {form.publishedRevisionNumber === undefined && (
                    <ToneBadge
                      label={t("portal.list.draftOnly")}
                      tone="neutral"
                    />
                  )}
                </div>
                {form.description && (
                  <p className="m-0 text-[0.85rem] text-muted-foreground">
                    {form.description}
                  </p>
                )}
                <dl className="mt-auto grid grid-flow-col justify-start gap-3 border-t border-border pt-3">
                  <div className="flex flex-col justify-between">
                    <dt className="text-[0.7rem] tracking-[0.04em] text-muted-foreground uppercase">
                      {t("portal.list.drafts")}
                    </dt>
                    <dd className="m-0 mt-0.5 text-[1.1rem] tabular-nums">
                      {form.submissionCounts.draft}
                    </dd>
                  </div>
                  <div className="flex flex-col justify-between">
                    <dt className="text-[0.7rem] tracking-[0.04em] text-muted-foreground uppercase">
                      {t("portal.list.submitted")}
                    </dt>
                    <dd className="m-0 mt-0.5 text-[1.1rem] tabular-nums">
                      {form.submissionCounts.submitted}
                    </dd>
                  </div>
                  <div className="flex flex-col justify-between">
                    <dt className="text-[0.7rem] tracking-[0.04em] text-muted-foreground uppercase">
                      {t("portal.list.changesRequested")}
                    </dt>
                    <dd className="m-0 mt-0.5 text-[1.1rem] tabular-nums">
                      {form.submissionCounts.changesRequested}
                    </dd>
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
  const { t } = useTranslation("forms");
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

  if (form.isLoading)
    return <PortalLoading label={t("portal.detail.loading")} />;
  if (form.isError || !form.data) {
    return (
      <PortalNotice variant="danger" title={t("portal.detail.unavailable")}>
        {t("portal.detail.unavailableBody")}{" "}
        <Link to="/forms" className="text-link">
          {t("portal.detail.backToForms")}
        </Link>
      </PortalNotice>
    );
  }
  const detail = form.data;
  const published = detail.publishedRevision;
  const canSubmit = canSubmitToForm(detail.grantedCapabilities);
  const mine = records.data?.items ?? [];
  const total = records.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / MINE_PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <PortalHeader
        eyebrow={t("portal.detail.eyebrow")}
        title={published?.title || detail.name}
        description={published?.description || detail.description}
        actions={
          canSubmit && published ? (
            <Link
              to={`/forms/${detail.id}/new`}
              className={buttonVariants({ variant: "default" })}
            >
              {t("portal.detail.start")}
            </Link>
          ) : undefined
        }
      />

      {justSubmitted && (
        <PortalNotice variant="success" title={t("portal.detail.sentTitle")}>
          {t("portal.detail.sentBody")}
        </PortalNotice>
      )}

      {!published && (
        <PortalNotice variant="info" title={t("portal.detail.notOpen")}>
          {t("portal.detail.notOpenBody")}
        </PortalNotice>
      )}
      {published && !canSubmit && (
        <PortalNotice variant="info" title={t("portal.detail.viewOnly")}>
          {t("portal.detail.viewOnlyBody")}
        </PortalNotice>
      )}

      <section
        aria-label={t("portal.detail.submissionsLabel")}
        className="flex flex-col gap-3"
      >
        <h2 className="m-0 text-base font-semibold">
          {t("portal.detail.submissionsTitle")}
        </h2>
        {records.isLoading ? (
          <PortalLoading label={t("portal.detail.submissionsLoading")} />
        ) : mine.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("portal.detail.submissionsEmpty")}</EmptyTitle>
              <EmptyDescription>
                {canSubmit && published
                  ? t("portal.detail.submissionsEmptySubmit")
                  : t("portal.detail.submissionsEmptyNone")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ul className="m-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card p-0">
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
              <PortalPagination
                label={t("portal.detail.submissionsPages")}
                status={t("portal.detail.pagination", {
                  page,
                  totalPages,
                  total,
                })}
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
  const { t } = useTranslation("forms");
  const locale = useFormatLocale();
  return (
    <li>
      <Link
        to={`/forms/${formId}/submissions/${record.id}`}
        className="grid min-h-[52px] grid-cols-[1fr_auto_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-inherit no-underline hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-[700px]:grid-cols-[1fr_auto]"
      >
        <span className="font-semibold">
          {record.displayTitle || t("portal.detail.untitled")}
        </span>
        <ToneBadge
          label={stateLabel(workflow, record.state)}
          tone={stateTone(workflow, record.state)}
        />
        <span className="text-[0.8rem] text-muted-foreground tabular-nums max-[700px]:col-span-full">
          {t("portal.detail.updatedAt", {
            date: new Date(record.updatedAt).toLocaleString(locale),
          })}
        </span>
      </Link>
    </li>
  );
}

// FormPortalSubmissionPage hosts the submission editor for a new or existing submission.
export function FormPortalSubmissionPage() {
  const { t } = useTranslation(["forms", "common"]);
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
    return <PortalLoading label={t("portal.submission.loading")} />;
  }
  if (form.isError || !form.data) {
    return (
      <PortalNotice variant="danger" title={t("portal.submission.unavailable")}>
        <Link to="/forms" className="text-link">
          {t("portal.submission.backToForms")}
        </Link>
      </PortalNotice>
    );
  }
  if (recordId && (record.isError || !record.data)) {
    return (
      <PortalNotice
        variant="danger"
        title={t("portal.submission.recordUnavailable")}
      >
        {t("portal.submission.recordDenied")}{" "}
        <Link to={`/forms/${id}`} className="text-link">
          {t("portal.submission.backToForm")}
        </Link>
      </PortalNotice>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PortalHeader
        eyebrow={form.data.publishedRevision?.title || form.data.name}
        title={
          recordId
            ? t("portal.submission.editTitle")
            : t("portal.submission.newTitle")
        }
        actions={
          <Link
            to={`/forms/${id}`}
            className={buttonVariants({ variant: "ghost" })}
          >
            <ArrowLeft size={16} aria-hidden="true" />{" "}
            {t("common:actions.back")}
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
