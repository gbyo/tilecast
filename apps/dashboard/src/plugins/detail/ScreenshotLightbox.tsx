import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { PluginStoreScreenshot } from "../../api/types";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

type Direction = "previous" | "next";

/**
 * One screenshot at full size, with the rest a step away. Previous and Next
 * and the arrow keys move through the listing without closing the dialog,
 * and stop at the ends, as the carousel does. The arrow keys follow the
 * reading direction. Escape and the close button leave through the Dialog,
 * which hands focus back to the slide that opened it.
 */
export function ScreenshotLightbox({
  screenshots,
  index,
  onIndexChange,
  onClose,
}: {
  screenshots: PluginStoreScreenshot[];
  /** The open screenshot, or null while the dialog is closed. */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("plugins");
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [last, setLast] = useState<Direction | null>(null);
  const selected = index === null ? undefined : screenshots[index];
  const total = screenshots.length;
  const many = total > 1;
  const atStart = index === 0;
  const atEnd = index === total - 1;

  // A button that reaches an end disables itself while it holds focus. Hand
  // focus to the opposite button so the dialog never loses its place.
  useEffect(() => {
    if (last === "previous" && atStart) nextRef.current?.focus();
    if (last === "next" && atEnd) previousRef.current?.focus();
  }, [last, atStart, atEnd, index]);

  const step = (direction: Direction) => {
    if (index === null) return;
    const target = direction === "next" ? index + 1 : index - 1;
    if (target < 0 || target >= total) return;
    setLast(direction);
    onIndexChange(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!many || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const backKey = rtl ? "ArrowRight" : "ArrowLeft";
    event.preventDefault();
    step(event.key === backKey ? "previous" : "next");
  };

  return (
    <Dialog
      open={selected !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          setLast(null);
          onClose();
        }
      }}
    >
      <DialogContent className="gap-3 p-3 sm:max-w-5xl" onKeyDown={onKeyDown}>
        <DialogHeader className="px-1 pr-8">
          <DialogTitle className="sr-only">
            {t("storeDetail.screenshots.lightboxTitle", {
              current: (index ?? 0) + 1,
              total,
            })}
          </DialogTitle>
          <DialogDescription>{selected?.alt}</DialogDescription>
        </DialogHeader>
        {selected && (
          <img
            src={selected.url}
            alt={selected.alt}
            decoding="async"
            referrerPolicy="no-referrer"
            className="max-h-[75vh] w-full rounded-lg bg-muted object-contain"
          />
        )}
        {many && index !== null && (
          <div className="flex items-center justify-center gap-3">
            <Button
              ref={previousRef}
              variant="outline"
              size="icon-sm"
              disabled={atStart}
              onClick={() => step("previous")}
            >
              <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
              <span className="sr-only">
                {t("storeDetail.screenshots.previous")}
              </span>
            </Button>
            <p
              aria-live="polite"
              className="min-w-16 text-center text-sm text-muted-foreground tabular-nums"
            >
              {t("storeDetail.screenshots.position", {
                current: index + 1,
                total,
              })}
            </p>
            <Button
              ref={nextRef}
              variant="outline"
              size="icon-sm"
              disabled={atEnd}
              onClick={() => step("next")}
            >
              <ArrowRight aria-hidden="true" className="rtl:rotate-180" />
              <span className="sr-only">
                {t("storeDetail.screenshots.next")}
              </span>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
