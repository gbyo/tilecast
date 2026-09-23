import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormDataSource, FormOutputView } from "../api/types";
import { api } from "../api/client";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
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
  const queryClient = useQueryClient();
  const outputs = useQuery({
    queryKey: ["form-outputs", form.id],
    queryFn: () => api.getFormOutputs(form.id),
  });

  const rebuild = useMutation({
    mutationFn: () => api.rebuildFormOutputs(form.id, csrf),
    onSuccess: (data) => {
      queryClient.setQueryData(["form-outputs", form.id], data);
      void queryClient.invalidateQueries({
        queryKey: ["data-source", form.id],
      });
    },
  });

  if (outputs.isLoading) return <Spinner aria-label="Loading outputs…" />;
  if (outputs.isError || !outputs.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load outputs</AlertTitle>
        <AlertDescription>
          {outputs.error instanceof Error
            ? outputs.error.message
            : "Please try again."}
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
              {data.errorCode ? "Projection error" : "Stale cache"}
            </Badge>
          ) : (
            <Badge {...formToneBadgeProps("success")}>Up to date</Badge>
          )}
          <span>
            Last projection:{" "}
            {data.lastSuccessAt
              ? new Date(data.lastSuccessAt).toLocaleString()
              : "never"}
          </span>
          <span>
            Next refresh:{" "}
            {data.nextRefreshAt
              ? new Date(data.nextRefreshAt).toLocaleString()
              : "on change"}
          </span>
        </div>
        {canManage && (
          <RheaButton
            variant="secondary"
            disabled={rebuild.isPending}
            aria-busy={rebuild.isPending || undefined}
            onClick={() => rebuild.mutate()}
          >
            {rebuild.isPending && <Spinner aria-hidden="true" />}
            Rebuild outputs
          </RheaButton>
        )}
      </div>

      {rebuild.isError && (
        <Alert variant="destructive">
          <AlertTitle>Rebuild failed</AlertTitle>
          <AlertDescription>
            {rebuild.error instanceof Error
              ? rebuild.error.message
              : "Please try again."}
          </AlertDescription>
        </Alert>
      )}
      {data.errorCode && (
        <Alert variant="destructive">
          <AlertTitle>Projection error</AlertTitle>
          <AlertDescription>
            The last projection reported: {data.errorCode}
          </AlertDescription>
        </Alert>
      )}

      {data.views.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No saved views</EmptyTitle>
            <EmptyDescription>
              Create a view in the Views tab to generate an output dataset.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        data.views.map((view) => <OutputViewCard key={view.key} view={view} />)
      )}
    </div>
  );
}

function OutputViewCard({ view }: { view: FormOutputView }) {
  return (
    <section
      className="grid gap-2 rounded-xl border border-border p-4"
      aria-label={`Output ${view.name}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 className="text-base font-semibold">{view.name}</h3>
          <code className="text-xs text-muted-foreground">{view.key}</code>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge {...formToneBadgeProps("neutral")}>
            {`${view.recordCount} records`}
          </Badge>
          {view.usage.widgets > 0 && (
            <Badge {...formToneBadgeProps("info")}>
              {`Used by ${view.usage.widgets} widget${view.usage.widgets === 1 ? "" : "s"}`}
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
          Referenced by: {view.usage.names.join(", ")}
        </p>
      )}

      {view.previewRecords.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No records match this view yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                {view.fields.map((field) => (
                  <th
                    key={field.key}
                    scope="col"
                    className="px-3 py-2 font-medium"
                  >
                    {field.label || field.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.previewRecords.map((record) => (
                <tr
                  key={record.id}
                  className="border-b border-border last:border-0"
                >
                  {view.fields.map((field) => (
                    <td key={field.key} className="px-3 py-2">
                      {record.values[field.key] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
