import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, Plus } from "lucide-react";
import { Link } from "react-router";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { canManageContent } from "./ContentPage";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { buttonVariants } from "../components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Skeleton } from "../components/ui/skeleton";
import { PluginActionsMenu } from "../plugins/PluginActionsMenu";
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
        <div className="flex flex-wrap items-center gap-2">
          {canCreate && (
            <Link
              className={buttonVariants({ variant: "default" })}
              to="/plugins/forms/new"
            >
              <Plus data-icon="inline-start" aria-hidden="true" /> Create form
            </Link>
          )}
          <PluginActionsMenu pluginId="forms" />
        </div>
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
        <ItemGroup className="gap-2" aria-busy="true">
          {[0, 1].map((key) => (
            <Skeleton key={key} className="h-20 rounded-2xl" />
          ))}
        </ItemGroup>
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
        <ItemGroup className="gap-2">
          {forms.data?.map((form) => (
            <Item variant="outline" key={form.id}>
              <ItemContent>
                <ItemTitle>
                  <h2 className="truncate text-sm font-medium">{form.name}</h2>
                  <Badge variant="secondary">
                    {form.publishedRevisionNumber
                      ? `Published revision ${form.publishedRevisionNumber}`
                      : "Draft"}
                  </Badge>
                </ItemTitle>
                <ItemDescription>
                  {form.description || "No description"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to={`/plugins/forms/${form.id}`}
                >
                  Manage form
                </Link>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </main>
  );
}
