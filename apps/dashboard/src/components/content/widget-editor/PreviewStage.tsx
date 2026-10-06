/**
 * The preview stage: the framed Widget on a neutral surface, with a short
 * note only when the preview is not simply healthy.
 */
import { AlertCircle, Info } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";
import { Spinner } from "@/components/ui/spinner";
import type { PreviewStatus } from "./preview/previewStatus";
import { STAGE_PADDING } from "./usePreviewView";

export function PreviewStage({
  stageRef,
  status,
  children,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  status: PreviewStatus;
  children: ReactNode;
}) {
  const { t } = useTranslation("content");
  return (
    <div
      ref={stageRef}
      role="region"
      aria-label={t("widgets.editor.preview.region")}
      aria-busy={
        status.kind === "loading" || status.kind === "waiting"
          ? true
          : undefined
      }
      className="relative min-h-0 flex-1 overflow-auto bg-muted/50"
    >
      <div
        className="flex min-h-full min-w-full items-center justify-center"
        style={{ padding: STAGE_PADDING }}
      >
        <div className="shrink-0 shadow-sm ring-1 ring-border">{children}</div>
      </div>
      <PreviewStatusNote status={status} />
    </div>
  );
}

/**
 * Silent when the preview is healthy. Otherwise one short line with an
 * icon, never color alone.
 */
function PreviewStatusNote({ status }: { status: PreviewStatus }) {
  const { t } = useTranslation("content");
  if (status.kind === "ready") return null;
  const text =
    status.kind === "loading"
      ? t("widgets.editor.preview.loading")
      : status.kind === "waiting"
        ? t("widgets.editor.preview.waiting")
        : status.message;
  const icon =
    status.kind === "loading" || status.kind === "waiting" ? (
      <Spinner aria-hidden="true" />
    ) : status.kind === "error" ? (
      <AlertCircle aria-hidden="true" />
    ) : (
      <Info aria-hidden="true" />
    );
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
      <p
        role={status.kind === "error" ? "alert" : "status"}
        className={cn(
          "pointer-events-auto flex max-w-xl items-start gap-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-sm [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0",
          status.kind === "error" && "text-destructive",
        )}
      >
        {icon}
        <span className="grid gap-0.5">
          <span>{text}</span>
          {status.kind === "error" && status.detail && (
            <span className="text-muted-foreground">{status.detail}</span>
          )}
        </span>
      </p>
    </div>
  );
}
