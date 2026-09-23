import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, Plus } from "lucide-react";
import { Link } from "react-router";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState, Notice, PageHeader } from "../components/legacy-ui";
import { canManageContent } from "./ContentPage";
import "./PluginsPage.css";

export function FormsPluginPage() {
  const auth = useAuth();
  const canCreate = canManageContent(auth.status?.user);
  const forms = useQuery({
    queryKey: ["forms"],
    queryFn: api.listForms,
    retry: false,
  });

  return (
    <main className="page plugins-page">
      <PageHeader
        eyebrow={
          <Link className="back-link" to="/plugins">
            <ArrowLeft size={15} /> Plugins
          </Link>
        }
        title="Forms"
        description="Build forms, manage responses, and make approved records available to signage."
        actions={
          canCreate ? (
            <Link className="button button--primary" to="/plugins/forms/new">
              <Plus size={16} aria-hidden="true" /> Create form
            </Link>
          ) : undefined
        }
      />
      {forms.isError && (
        <Notice variant="danger" title="Could not load forms">
          {forms.error instanceof ApiError
            ? forms.error.message
            : "Forms could not be loaded."}
        </Notice>
      )}
      {forms.isLoading ? (
        <div className="table-loading">Loading forms…</div>
      ) : forms.data?.length === 0 ? (
        <EmptyState
          icon={<ClipboardList size={24} aria-hidden="true" />}
          title="No forms yet"
          message={
            canCreate
              ? "Create a form to start collecting submissions."
              : "You do not have access to any forms."
          }
          action={
            canCreate ? (
              <Link className="button button--primary" to="/plugins/forms/new">
                Create form
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="plugin-instance-list">
          {forms.data?.map((form) => (
            <article className="plugin-instance" key={form.id}>
              <div>
                <div className="plugin-instance__heading">
                  <h2>{form.name}</h2>
                </div>
                <p>{form.description || "No description"}</p>
                <span className="plugin-card__instances">
                  {form.publishedRevisionNumber
                    ? `Published revision ${form.publishedRevisionNumber}`
                    : "Draft"}
                </span>
              </div>
              <Link
                className="button button--secondary"
                to={`/plugins/forms/${form.id}`}
              >
                Manage form
              </Link>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
