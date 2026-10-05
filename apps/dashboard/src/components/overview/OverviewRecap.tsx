import { useTranslation } from "react-i18next";
import { Skeleton } from "../ui/skeleton";
import { recapMessage, type OverviewRecap as Recap } from "./recap";

/**
 * The page's one-sentence answer to "what state is my fleet in right now".
 * It is a paragraph, not a heading: the page title is the hidden h1, and the
 * cards below carry the evidence. Static text, so it does not announce itself
 * as the figures refresh.
 */
export function OverviewRecap({ recap }: { recap: Recap }) {
  const { t } = useTranslation("activity");
  const { key, options } = recapMessage(recap);
  return (
    <p
      data-testid="overview-recap"
      className="max-w-3xl text-lg leading-7 font-medium tracking-tight text-balance"
    >
      {t(key, options)}
    </p>
  );
}

/** One line of the headline's height, so the cards do not jump on load. */
export function OverviewRecapSkeleton() {
  return (
    <div aria-hidden="true" className="flex h-7 items-center">
      <Skeleton className="h-5 w-full max-w-md" />
    </div>
  );
}
