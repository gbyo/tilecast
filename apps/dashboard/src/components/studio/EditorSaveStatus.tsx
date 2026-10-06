import {
  CircleAlert,
  CircleDot,
  CloudCheck,
  Eye,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

export type EditorSaveState =
  "saved" | "unsaved" | "saving" | "error" | "conflict" | "readOnly";

/**
 * An immersive editor's save state, as status rather than a button: an icon
 * and text, never color alone. Only a failed save offers an inline retry.
 * Each editor supplies its own wording.
 */
export function EditorSaveStatus({
  state,
  labels,
  onRetry,
  compact = false,
}: {
  state: EditorSaveState;
  labels: Partial<Record<EditorSaveState, string>> & { saved: string };
  onRetry?: () => void;
  /** Icon only, with the label kept for assistive technology. */
  compact?: boolean;
}) {
  const { t } = useTranslation("common");
  const label =
    labels[state] ?? (state === "saving" ? t("actions.saving") : labels.saved);
  const Icon =
    state === "unsaved"
      ? CircleDot
      : state === "error"
        ? CircleAlert
        : state === "conflict"
          ? TriangleAlert
          : state === "readOnly"
            ? Eye
            : CloudCheck;
  return (
    <div className="flex items-center gap-2">
      <span
        role="status"
        aria-label={compact ? label : undefined}
        title={compact ? label : undefined}
        className={cn(
          "flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground [&_svg]:size-3.5",
          (state === "error" || state === "conflict") && "text-destructive",
        )}
      >
        {state === "saving" ? (
          <Spinner aria-hidden="true" />
        ) : (
          <Icon aria-hidden="true" />
        )}
        <span
          className={
            compact
              ? "sr-only"
              : state === "saved"
                ? "max-xl:sr-only"
                : undefined
          }
        >
          {label}
        </span>
      </span>
      {!compact && state === "error" && onRetry && (
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          {t("actions.retry")}
        </Button>
      )}
    </div>
  );
}
