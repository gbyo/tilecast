import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { FormDataSource, FormOutputView } from "../api/types";
import { api } from "../api/client";
import { useFormatLocale } from "../i18n";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import { formToneBadgeProps } from "./formBadge";

// OutputsPanel shows the generated dataset for each saved view plus projection status, and lets a
// manager manually rebuild. Preview records come from the cached projection, so only output-eligible
// records are ever shown (never unapproved records or attachment binaries).
export function OutputsPanel({
  form,
  csrf,
  canManage,
}: {
  form: FormDataSource;
  csrf: string;
  canManage: boolean;
}) {
  const { t } = useTranslation("forms");
  const locale = useFormatLocale();
  const queryClient = useQueryClient();
  const outputs = useQuery({
    queryKey: ["form-outputs", form.id],
    queryFn: () => api.getFormOutputs(form.id),
  });

  const rebuild = useMutation({
    mutationFn: () => api.rebuildFormOutputs(form.id, csrf),
    onSuccess: (data) => {
      toast.add({ title: "Form outputs rebuilt.", type: "success" });
      queryClient.setQueryData(["form-outputs", form.id], data);
      void queryClient.invalidateQueries({
        queryKey: ["data-source", form.id],
      });
    },
  });

  if (outputs.isLoading) return <Spinner aria-label={t("outputs.loading")} />;
  if (outputs.isError || !outputs.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("outputs.loadError")}</AlertTitle>
        <AlertDescription>
          {outputs.error instanceof Error
            ? outputs.error.message
            : t("outputs.retry")}
        </AlertDescription>
      </Alert>
    );
  }
  const data = outputs.data;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {data.stale ? (
            <Badge
              {...formToneBadgeProps(data.errorCode ? "danger" : "warning")}
            >
              {data.errorCode
                ? t("outputs.projectionError")
                : t("outputs.staleCache")}
            </Badge>
          ) : (
            <Badge {...formToneBadgeProps("success")}>
              {t("outputs.upToDate")}
            </Badge>
          )}
          <span>
            {t("outputs.lastProjection", {
              value: data.lastSuccessAt
                ? new Date(data.lastSuccessAt).toLocaleString(locale)
                : t("outputs.never"),
            })}
          </span>
          <span>
            {t("outputs.nextRefresh", {
              value: data.nextRefreshAt
                ? new Date(data.nextRefreshAt).toLocaleString(locale)
                : t("outputs.onChange"),
            })}
          </span>
        </div>
        {canManage && (
          <Button
            variant="secondary"
            disabled={rebuild.isPending}
            aria-busy={rebuild.isPending || undefined}
            onClick={() => rebuild.mutate()}
          >
            {rebuild.isPending && <Spinner aria-hidden="true" />}
            {t("outputs.rebuild")}
          </Button>
        )}
      </div>

      {rebuild.isError && (
        <Alert variant="destructive">
          <AlertTitle>{t("outputs.rebuildError")}</AlertTitle>
          <AlertDescription>
            {rebuild.error instanceof Error
              ? rebuild.error.message
              : t("outputs.retry")}
          </AlertDescription>
        </Alert>
      )}
      {data.errorCode && (
        <Alert variant="destructive">
          <AlertTitle>{t("outputs.projectionError")}</AlertTitle>
          <AlertDescription>
            {t("outputs.lastReport", { code: data.errorCode })}
          </AlertDescription>
        </Alert>
      )}

      {data.views.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("outputs.noViews")}</EmptyTitle>
            <EmptyDescription>{t("outputs.noViewsHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        data.views.map((view) => <OutputViewCard key={view.key} view={view} />)
      )}
    </div>
  );
}

function OutputViewCard({ view }: { view: FormOutputView }) {
  const { t } = useTranslation("forms");
  return (
    <section
      className="grid gap-2 rounded-xl border border-border p-4"
      aria-label={t("outputs.viewLabel", { name: view.name })}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 className="text-base font-semibold">{view.name}</h3>
          <code className="text-xs text-muted-foreground">{view.key}</code>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge {...formToneBadgeProps("neutral")}>
            {t("outputs.recordCount", { count: view.recordCount })}
          </Badge>
          {view.usage.widgets > 0 && (
            <Badge {...formToneBadgeProps("info")}>
              {t("outputs.usedByWidgets", { count: view.usage.widgets })}
            </Badge>
          )}
        </div>
      </header>

      <p className="flex flex-wrap gap-1 text-sm">
        {view.fields.map((field) => (
          <span
            key={field.key}
            className="rounded-lg bg-muted px-2 py-0.5 text-xs"
          >
            {field.label || field.key}
            <em className="text-muted-foreground not-italic">
              {" "}
              · {field.type}
            </em>
          </span>
        ))}
      </p>

      {view.usage.names.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("outputs.referencedBy", { names: view.usage.names.join(", ") })}
        </p>
      )}

      {view.previewRecords.length === 0 ? (
        <Empty className="border-0 py-6">
          <EmptyHeader>
            <EmptyTitle>{t("outputs.noRecords")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
                {view.fields.map((field) => (
                  <TableHead
                    key={field.key}
                    scope="col"
                    className="px-3 py-2 font-medium"
                  >
                    {field.label || field.key}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.previewRecords.map((record) => (
                <TableRow
                  key={record.id}
                  className="border-b border-border last:border-0"
                >
                  {view.fields.map((field) => (
                    <TableCell key={field.key} className="px-3 py-2">
                      {record.values[field.key] ?? ""}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
