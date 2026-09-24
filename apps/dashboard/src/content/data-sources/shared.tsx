import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button as RheaButton } from "../../components/ui/button";

// Providers handled by a dedicated legacy editor below. Anything not listed here is a
// release-defined Source that routes to the generic, definition-driven editor.
export const legacyDataSourceProviders = new Set<string>([
  "manual",
  "weather",
  "calendar",
  "transit",
  "cap_alerts",
  "air_quality",
  "rss",
  "atom",
  "json",
  "csv",
]);

// A closed Base UI trigger can only show an item's label while that item is
// mounted; the dropdown items unmount with the closed popup, so triggers name
// their own label explicitly instead of showing the raw stored value.
export function optionLabel(
  options: { value: string | number; label: string }[],
  value: string | number,
): string {
  return (
    options.find((option) => option.value === value)?.label ?? String(value)
  );
}

export function EditorFrame({
  title,
  description,
  page,
  onClose,
  children,
  footer,
}: {
  title: string;
  description: string;
  page?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { t } = useTranslation(["content", "common"]);
  return (
    <div
      className={
        page
          ? "grid w-full min-w-0 gap-5"
          : "fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4"
      }
      role={page ? undefined : "presentation"}
    >
      <section
        className={
          page
            ? "grid w-full min-w-0 gap-5"
            : "mx-auto grid w-full max-w-3xl gap-5 rounded-xl bg-background p-5"
        }
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("common:actions.close")}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </RheaButton>
        </div>
        <div className="grid min-w-0 gap-5">{children}</div>
        <footer className="flex flex-wrap items-center gap-2">{footer}</footer>
      </section>
    </div>
  );
}
