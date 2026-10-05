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

/**
 * The headline's height, so the cards do not jump on load: one line, or two
 * where the sentence wraps on a narrow screen.
 */
export function OverviewRecapSkeleton() {
  return (
    <div aria-hidden="true" className="grid">
      <div className="flex h-7 items-center">
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <div className="flex h-7 items-center sm:hidden">
        <Skeleton className="h-5 w-2/3" />
      </div>
    </div>
  );
}
