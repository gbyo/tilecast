/**
 * What the editor route shows when it cannot open an editor: loading, a
 * Widget that is missing or failed to load, a catalog that did not load, no
 * permission, and a Widget type that cannot be authored. There is no other
 * editor to fall back to (docs/widget-authoring.md).
 */
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Blocks } from "lucide-react";
import type { WidgetDefinition } from "@/api/types";
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
import type { WidgetAuthoring } from "./widgetAuthoring";

export function EditorSkeleton({ label }: { label: string }) {
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

export function EditorProblem({
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
export function UnavailableWidgetType({
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
