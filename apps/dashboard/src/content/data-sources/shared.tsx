import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

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

export function optionLabel(
  options: readonly { value: string | number; label: string }[],
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

  if (!page) {
    return (
      <Dialog
        open
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
      >
        <DialogContent
          className="max-h-[calc(100vh-2rem)] w-[min(48rem,calc(100vw-2rem))] max-w-none overflow-y-auto"
          showCloseButton={false}
        >
          <DialogHeader className="relative pr-10">
            <DialogTitle className="text-xl font-semibold">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute -top-2 right-0"
              aria-label={t("common:actions.close")}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </DialogHeader>
          <div className="grid min-w-0 gap-5">{children}</div>
          <DialogFooter className="flex-row flex-wrap justify-start">
            {footer}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="grid w-full min-w-0 gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("common:actions.close")}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="grid min-w-0 gap-5">{children}</div>
      <footer className="flex flex-wrap items-center gap-2">{footer}</footer>
    </div>
  );
}
