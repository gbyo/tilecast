/**
 * /widgets/new, /widgets/new/:provider, and /widgets/:id.
 *
 * The route only loads and resolves: the saved Widget, the catalog, the
 * Widget's definition and authoring contract, and permission. Every
 * authorable Widget then opens in the same WidgetEditorWorkspace; there is
 * no per-provider editor and no fallback editor (docs/widget-authoring.md).
 */
import { useQuery } from "@tanstack/react-query";
import { Blocks, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router";
import { ApiError } from "@/api/client";
import type { Asset, WidgetDefinition } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { WidgetEditorWorkspace } from "@/components/content/widget-editor/WidgetEditorWorkspace";
import { useWidgetEditorSession } from "@/components/content/widget-editor/useWidgetEditorSession";
import {
  widgetAuthoring,
  type WidgetAuthoring,
} from "@/components/content/widget-editor/widgetAuthoring";
import { WidgetProviderGallery } from "@/content/SourceEditors";
import { contentQueries } from "@/data/content";
import { apiErrorMessage } from "@/i18n";
import { inAppPath } from "@/navigation/returnPaths";
import { canManageContent } from "./ContentPage";

export function WidgetEditorPage() {
  const { t } = useTranslation(["content", "common"]);
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { id, provider: providerParam } = useParams();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = canManageContent(auth.status?.user);
  const search = new URLSearchParams(location.search);
  // Return paths come from the URL, so only an in-app route is honored.
  const returnTo = inAppPath(search.get("returnTo"));
  // Creating a Widget replaces the route, so "created on this trip" lives
  // in the URL to survive it (see useWidgetEditorSession).
  const createdHere = search.get("created") === "1";
  const widget = useQuery({
    ...contentQueries.asset(id ?? ""),
    retry: false,
  });
  const definitions = useQuery(contentQueries.definitions());
  const leave = () => void navigate(returnTo ?? "/widgets");

  if (!id && !providerParam)
    return (
      <section className="app-editor-route">
        <WidgetProviderGallery
          page
          onClose={leave}
          onChoose={(choice, preset) => {
            // Choosing a type is a step inside the create flow, so the
            // return path has to survive it.
            const query = new URLSearchParams();
            if (preset) query.set("preset", preset);
            if (returnTo) query.set("returnTo", returnTo);
            void navigate(
              `/widgets/new/${choice}${query.size ? `?${query.toString()}` : ""}`,
            );
          }}
        />
      </section>
    );

  if ((id && widget.isLoading) || definitions.isLoading)
    return <EditorSkeleton label={t("widgets.editor.loading")} />;

  if (id && widget.isError) {
    const notFound =
      widget.error instanceof ApiError && widget.error.status === 404;
    return (
      <EditorProblem
        icon={<SearchX aria-hidden="true" />}
        title={
          notFound
            ? t("widgets.editor.problems.notFoundTitle")
            : t("widgets.editor.problems.loadFailedTitle")
        }
        description={
          notFound
            ? t("widgets.editor.problems.notFound")
            : apiErrorMessage(widget.error)
        }
        onRetry={notFound ? undefined : () => void widget.refetch()}
        onBack={leave}
        backLabel={t("widgets.detail.backToWidgets")}
      />
    );
  }
  if (definitions.isError || !definitions.data)
    return (
      <EditorProblem
        icon={<Blocks aria-hidden="true" />}
        title={t("widgets.editor.problems.catalogTitle")}
        description={t("widgets.editor.problems.catalog")}
        onRetry={() => void definitions.refetch()}
        onBack={leave}
        backLabel={t("widgets.detail.backToWidgets")}
      />
    );

  const asset = id ? widget.data : undefined;
  const provider = providerParam ?? asset?.widget?.provider;
  const definition = definitions.data.widgets.find(
    (candidate) => candidate.id === provider,
  );
  const authoring = definition
    ? widgetAuthoring(definition, definitions.data)
    : null;
  if (!definition || !authoring || authoring.kind === "unsupported")
    return (
      <UnavailableWidgetType
        definition={definition}
        authoring={authoring}
        onBack={leave}
      />
    );
  // A viewer and an existing Widget being viewed can never create; a
  // viewer reaching a create route has nothing to edit.
  if (!asset && !canManage)
    return (
      <EditorProblem
        icon={<Blocks aria-hidden="true" />}
        title={t("widgets.editor.problems.noPermissionTitle")}
        description={t("widgets.editor.problems.noPermission")}
        onBack={leave}
        backLabel={t("widgets.detail.backToWidgets")}
      />
    );

  return (
    <WidgetEditorSessionHost
      key={asset?.id ?? `new:${definition.id}`}
      definition={definition}
      authoring={authoring}
      asset={asset}
      csrf={csrf}
      canManage={canManage}
      returnTo={returnTo}
      createdHere={createdHere}
    />
  );
}

function WidgetEditorSessionHost({
  definition,
  authoring,
  asset,
  csrf,
  canManage,
  returnTo,
  createdHere,
}: {
  definition: WidgetDefinition;
  authoring: Exclude<WidgetAuthoring, { kind: "unsupported" }>;
  asset?: Asset;
  csrf: string;
  canManage: boolean;
  returnTo: string | null;
  createdHere: boolean;
}) {
  const session = useWidgetEditorSession({
    definition,
    authoring,
    asset,
    csrf,
    readOnly: !canManage,
    returnTo,
    createdHere,
  });
  return (
    <WidgetEditorWorkspace
      session={session}
      csrf={csrf}
      canManage={canManage}
    />
  );
}

function EditorSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex h-full min-h-0 flex-col gap-0 lg:flex-row"
    >
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/50 p-8">
        <Skeleton className="aspect-video w-full max-w-3xl" />
      </div>
      <div className="grid w-full content-start gap-4 border-s border-border p-4 lg:w-[32%]">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
      </div>
    </div>
  );
}

function EditorProblem({
  icon,
  title,
  description,
  onRetry,
  onBack,
  backLabel,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onRetry?: () => void;
  onBack: () => void;
  backLabel: string;
}) {
  const { t } = useTranslation("common");
  return (
    <section className="flex h-full items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>
            {title}
          </EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          {onRetry && (
            <Button type="button" variant="outline" onClick={onRetry}>
              {t("actions.retry")}
            </Button>
          )}
          <Button type="button" onClick={onBack}>
            {backLabel}
          </Button>
        </EmptyContent>
      </Empty>
    </section>
  );
}

/**
 * A Widget whose type cannot be authored: the provider is missing from
 * the catalog (its plugin was removed), retired, or does not describe
 * itself well enough for the editor. There is no other editor to open.
 */
function UnavailableWidgetType({
  definition,
  authoring,
  onBack,
}: {
  definition?: WidgetDefinition;
  authoring: WidgetAuthoring | null;
  onBack: () => void;
}) {
  const { t } = useTranslation("content");
  const reason = !definition
    ? t("widgets.editor.problems.typeMissing")
    : authoring?.kind === "unsupported" && authoring.reason === "unavailable"
      ? (definition.availability?.reason ??
        t("widgets.editor.problems.typeRetired"))
      : t("widgets.editor.problems.typeOutdated", { name: definition.name });
  return (
    <section className="flex h-full items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Blocks aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>
            {t("widgets.editor.problems.typeTitle")}
          </EmptyTitle>
          <EmptyDescription>{reason}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Alert className="text-start">
            <AlertDescription>
              {t("widgets.editor.problems.typeSaved")}
            </AlertDescription>
          </Alert>
          <Button type="button" onClick={onBack}>
            {t("widgets.detail.backToWidgets")}
          </Button>
        </EmptyContent>
      </Empty>
    </section>
  );
}
