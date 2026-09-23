import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormDataSource, FormOutputView } from "../api/types";
import { api } from "../api/client";
import {
  Button,
  EmptyState,
  Notice,
  Spinner,
  StatusBadge,
  TableContainer,
} from "../components/legacy-ui";

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

  if (outputs.isLoading) return <Spinner label="Loading outputs…" />;
  if (outputs.isError || !outputs.data) {
    return (
      <Notice variant="danger" title="Could not load outputs">
        {outputs.error instanceof Error
          ? outputs.error.message
          : "Please try again."}
      </Notice>
    );
  }
  const data = outputs.data;

  return (
    <div className="form-outputs">
      <div className="form-outputs__status">
        <div className="form-outputs__status-meta">
          {data.stale ? (
            <StatusBadge
              label={data.errorCode ? "Projection error" : "Stale cache"}
              tone="warning"
            />
          ) : (
            <StatusBadge label="Up to date" tone="success" />
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
          <Button
            variant="secondary"
            loading={rebuild.isPending}
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate()}
          >
            Rebuild outputs
          </Button>
        )}
      </div>

      {rebuild.isError && (
        <Notice variant="danger" title="Rebuild failed">
          {rebuild.error instanceof Error
            ? rebuild.error.message
            : "Please try again."}
        </Notice>
      )}
      {data.errorCode && (
        <Notice variant="danger" title="Projection error">
          The last projection reported: {data.errorCode}
        </Notice>
      )}

      {data.views.length === 0 ? (
        <EmptyState
          title="No saved views"
          message="Create a view in the Views tab to generate an output dataset."
        />
      ) : (
        data.views.map((view) => <OutputViewCard key={view.key} view={view} />)
      )}
    </div>
  );
}

function OutputViewCard({ view }: { view: FormOutputView }) {
  return (
    <section className="form-outputs__view" aria-label={`Output ${view.name}`}>
      <header className="form-outputs__view-head">
        <div>
          <h3>{view.name}</h3>
          <code className="form-outputs__dataset-key">{view.key}</code>
        </div>
        <div className="form-outputs__view-meta">
          <StatusBadge label={`${view.recordCount} records`} tone="neutral" />
          {view.usage.widgets > 0 && (
            <StatusBadge
              label={`Used by ${view.usage.widgets} widget${view.usage.widgets === 1 ? "" : "s"}`}
              tone="info"
            />
          )}
        </div>
      </header>

      <p className="form-outputs__fields">
        {view.fields.map((field) => (
          <span key={field.key} className="form-outputs__field">
            {field.label || field.key}
            <em> · {field.type}</em>
          </span>
        ))}
      </p>

      {view.usage.names.length > 0 && (
        <p className="form-outputs__usage">
          Referenced by: {view.usage.names.join(", ")}
        </p>
      )}

      {view.previewRecords.length === 0 ? (
        <p className="form-outputs__empty">No records match this view yet.</p>
      ) : (
        <TableContainer>
          <table className="data-table">
            <thead>
              <tr>
                {view.fields.map((field) => (
                  <th key={field.key} scope="col">
                    {field.label || field.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.previewRecords.map((record) => (
                <tr key={record.id}>
                  {view.fields.map((field) => (
                    <td key={field.key}>{record.values[field.key] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}
    </section>
  );
}
