import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import type { PluginStoreScreenshot } from "../../api/types";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "../../components/ui/carousel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

/** Embla needs the document direction to page the right way in RTL. */
function readingDirection() {
  return typeof document !== "undefined" &&
    document.documentElement.dir === "rtl"
    ? "rtl"
    : "ltr";
}

/**
 * A listing's screenshots. The carousel never advances on its own: several
 * slides show at once on wide viewports, and on a phone one slide leads with
 * the next peeking in so the row reads as swipeable. Selecting a slide opens
 * the full image in a dialog.
 *
 * Slides are sized so a frame stays near 16:9 and under about 300px tall on
 * wide viewports; the page leads with the plugin, not with its pictures.
 *
 * Listings without screenshots render nothing at all, not an empty frame.
 * Images load only from the server's own artwork paths, and any one may
 * fail, so a failed slide keeps its place with a quiet placeholder.
 */
export function PluginScreenshotCarousel({
  screenshots,
}: {
  screenshots: PluginStoreScreenshot[];
}) {
  const { t } = useTranslation("plugins");
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  if (screenshots.length === 0) return null;

  const markFailed = (url: string) =>
    setFailed((current) => new Set(current).add(url));
  const selected = openIndex === null ? undefined : screenshots[openIndex];
  const many = screenshots.length > 1;

  return (
    <section aria-labelledby="plugin-screenshots-heading">
      <h2 id="plugin-screenshots-heading" className="sr-only">
        {t("storeDetail.screenshots.title")}
      </h2>
      <Carousel
        opts={{
          align: "start",
          containScroll: "trimSnaps",
          direction: readingDirection(),
        }}
      >
        <CarouselContent className="-ms-3">
          {screenshots.map((shot, index) => (
            <CarouselItem
              key={shot.url}
              className="basis-[88%] ps-3 sm:basis-1/2 xl:basis-[38%]"
              aria-label={t("storeDetail.screenshots.slide", {
                current: index + 1,
                total: screenshots.length,
              })}
            >
              {failed.has(shot.url) ? (
                <div
                  role="img"
                  aria-label={shot.alt}
                  className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl bg-muted text-xs text-muted-foreground"
                >
                  <ImageOff className="size-5" aria-hidden="true" />
                  {t("storeDetail.screenshots.unavailable")}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setOpenIndex(index)}
                  aria-label={t("storeDetail.screenshots.open", {
                    alt: shot.alt,
                  })}
                  className="block aspect-video w-full cursor-zoom-in overflow-hidden rounded-xl bg-muted ring-1 ring-foreground/10 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <img
                    src={shot.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    referrerPolicy="no-referrer"
                    className="size-full object-cover"
                    onError={() => markFailed(shot.url)}
                  />
                </button>
              )}
            </CarouselItem>
          ))}
        </CarouselContent>
        {many && (
          <>
            <CarouselPrevious
              variant="secondary"
              className="top-1/2 start-2 shadow-sm"
            />
            <CarouselNext
              variant="secondary"
              className="top-1/2 end-2 shadow-sm"
            />
          </>
        )}
      </Carousel>
      <Dialog
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null);
        }}
      >
        <DialogContent className="gap-3 p-3 sm:max-w-5xl">
          <DialogHeader className="px-1 pr-8">
            <DialogTitle className="sr-only">
              {t("storeDetail.screenshots.lightboxTitle", {
                current: (openIndex ?? 0) + 1,
                total: screenshots.length,
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
        </DialogContent>
      </Dialog>
    </section>
  );
}
