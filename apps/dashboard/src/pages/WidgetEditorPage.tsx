/**
 * /widgets/new, /widgets/new/:provider, and /widgets/:id.
 *
 * The route only loads and resolves: the saved Widget, the catalog, the
 * Widget's definition and authoring contract, and permission
 * (widgetEditorRoute). Every authorable Widget then opens in the same
 * WidgetEditorWorkspace; there is no per-provider editor and no fallback
 * editor (docs/widget-authoring.md).
 */
import { useQuery } from "@tanstack/react-query";
import { Blocks, SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import {
  EditorProblem,
  EditorSkeleton,
  UnavailableWidgetType,
} from "@/components/content/widget-editor/WidgetEditorProblems";
import { WidgetEditorSessionHost } from "@/components/content/widget-editor/WidgetEditorSessionHost";
import { WidgetProviderGallery } from "@/content/SourceEditors";
import { contentQueries } from "@/data/content";
import { apiErrorMessage } from "@/i18n";
import { inAppPath } from "@/navigation/returnPaths";
import { canManageContent } from "./ContentPage";
import { resolveWidgetEditorRoute } from "./widgetEditorRoute";

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
  const route = resolveWidgetEditorRoute({
    id,
    providerParam,
    widget,
    definitions,
    canManage,
  });
  const backLabel = t("widgets.detail.backToWidgets");

  switch (route.kind) {
    case "gallery":
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
    case "loading":
      return <EditorSkeleton label={t("widgets.editor.loading")} />;
    case "assetFailed":
      return (
        <EditorProblem
          icon={<SearchX aria-hidden="true" />}
          title={
            route.notFound
              ? t("widgets.editor.problems.notFoundTitle")
              : t("widgets.editor.problems.loadFailedTitle")
          }
          description={
            route.notFound
              ? t("widgets.editor.problems.notFound")
              : apiErrorMessage(route.error)
          }
          onRetry={route.notFound ? undefined : () => void widget.refetch()}
          onBack={leave}
          backLabel={backLabel}
        />
      );
    case "catalogFailed":
      return (
        <EditorProblem
          icon={<Blocks aria-hidden="true" />}
          title={t("widgets.editor.problems.catalogTitle")}
          description={t("widgets.editor.problems.catalog")}
          onRetry={() => void definitions.refetch()}
          onBack={leave}
          backLabel={backLabel}
        />
      );
    case "unavailable":
      return (
        <UnavailableWidgetType
          definition={route.definition}
          authoring={route.authoring}
          onBack={leave}
        />
      );
    case "noPermission":
      return (
        <EditorProblem
          icon={<Blocks aria-hidden="true" />}
          title={t("widgets.editor.problems.noPermissionTitle")}
          description={t("widgets.editor.problems.noPermission")}
          onBack={leave}
          backLabel={backLabel}
        />
      );
    case "ready":
      return (
        <WidgetEditorSessionHost
          key={route.asset?.id ?? `new:${route.definition.id}`}
          definition={route.definition}
          authoring={route.authoring}
          asset={route.asset}
          csrf={csrf}
          canManage={canManage}
          returnTo={returnTo}
          createdHere={createdHere}
        />
      );
  }
}
