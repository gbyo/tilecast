import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, Plus } from "lucide-react";
import { Link } from "react-router";
import { formsApi } from "./api";
import {
  ApiError,
  PluginActionsMenu,
  usePluginTranslation,
  useStudioSession,
} from "@tilecast/studio";
import en from "./locales/en.json";
import { Alert, AlertDescription, AlertTitle } from "@tilecast/studio/ui/alert";
import { Badge } from "@tilecast/studio/ui/badge";
import { buttonVariants } from "@tilecast/studio/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@tilecast/studio/ui/item";
import { Skeleton } from "@tilecast/studio/ui/skeleton";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@tilecast/studio/ui/empty";

export function FormsPluginPage() {
  const { t } = usePluginTranslation("forms", en);
  const session = useStudioSession();
  // Creating a form needs a content-manager role (owner, administrator, or editor), not IAM manage.
  const canCreate = session.role !== undefined && session.role !== "viewer";
  const forms = useQuery({
    queryKey: ["forms"],
    queryFn: formsApi.listForms,
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
            <ArrowLeft size={15} aria-hidden="true" /> {t("plugin.breadcrumb")}
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">
            {t("plugin.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("plugin.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCreate && (
            <Link
              className={buttonVariants({ variant: "default" })}
              to="/plugins/forms/new"
            >
              <Plus data-icon="inline-start" aria-hidden="true" />{" "}
              {t("plugin.create")}
            </Link>
          )}
          <PluginActionsMenu pluginId="forms" />
        </div>
      </header>
      {forms.isError && (
        <Alert variant="destructive">
          <AlertTitle>{t("plugin.loadError")}</AlertTitle>
          <AlertDescription>
            {forms.error instanceof ApiError
              ? forms.error.message
              : t("plugin.loadFallback")}
          </AlertDescription>
        </Alert>
      )}
      {forms.isLoading ? (
        <ItemGroup className="gap-2" aria-busy="true">
          {[0, 1].map((key) => (
            <Skeleton key={key} className="h-20 rounded-xl" />
          ))}
        </ItemGroup>
      ) : forms.data?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardList size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("plugin.empty")}</EmptyTitle>
            <EmptyDescription>
              {canCreate ? t("plugin.emptyCreate") : t("plugin.emptyDenied")}
            </EmptyDescription>
          </EmptyHeader>
          {canCreate && (
            <EmptyContent>
              <Link
                className={buttonVariants({ variant: "default" })}
                to="/plugins/forms/new"
              >
                {t("plugin.create")}
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
                      ? t("plugin.publishedRevision", {
                          number: form.publishedRevisionNumber,
                        })
                      : t("plugin.draft")}
                  </Badge>
                </ItemTitle>
                <ItemDescription>
                  {form.description || t("plugin.noDescription")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to={`/plugins/forms/${form.id}`}
                >
                  {t("plugin.manage")}
                </Link>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </main>
  );
}
