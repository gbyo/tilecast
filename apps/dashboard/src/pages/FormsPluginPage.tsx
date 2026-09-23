import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, Plus } from "lucide-react";
import { Link } from "react-router";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { canManageContent } from "./ContentPage";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";

export function FormsPluginPage() {
  const auth = useAuth();
  const canCreate = canManageContent(auth.status?.user);
  const forms = useQuery({
    queryKey: ["forms"],
    queryFn: api.listForms,
    retry: false,
  });

  return (
    <main className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <Link
            to="/plugins"
            className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={15} aria-hidden="true" /> Plugins
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Forms</h1>
          <p className="text-sm text-muted-foreground">
            Build forms, manage responses, and make approved records available
            to signage.
          </p>
        </div>
        {canCreate && (
          <Link
            className={buttonVariants({ variant: "default" })}
            to="/plugins/forms/new"
          >
            <Plus size={16} aria-hidden="true" /> Create form
          </Link>
        )}
      </header>
      {forms.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load forms</AlertTitle>
          <AlertDescription>
            {forms.error instanceof ApiError
              ? forms.error.message
              : "Forms could not be loaded."}
          </AlertDescription>
        </Alert>
      )}
      {forms.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading forms…</p>
      ) : forms.data?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardList size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No forms yet</EmptyTitle>
            <EmptyDescription>
              {canCreate
                ? "Create a form to start collecting submissions."
                : "You do not have access to any forms."}
            </EmptyDescription>
          </EmptyHeader>
          {canCreate && (
            <EmptyContent>
              <Link
                className={buttonVariants({ variant: "default" })}
                to="/plugins/forms/new"
              >
                Create form
              </Link>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="grid gap-2">
          {forms.data?.map((form) => (
            <article
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
              key={form.id}
            >
              <div className="grid min-w-0 gap-0.5">
                <h2 className="truncate text-sm font-semibold">{form.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {form.description || "No description"}
                </p>
                <span className="text-xs text-muted-foreground">
                  {form.publishedRevisionNumber
                    ? `Published revision ${form.publishedRevisionNumber}`
                    : "Draft"}
                </span>
              </div>
              <Link
                className={buttonVariants({ variant: "secondary" })}
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
