import { cn } from "cn";
import type { ComponentProps } from "react";
import {
  ChevronDown,
  ChevronRight,
  type LucideProps,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent as VegaCollapsibleContent,
  CollapsibleTrigger as VegaCollapsibleTrigger,
} from "../ui/collapsible";

function CollapsibleTrigger({
  className,
  ...props
}: ComponentProps<typeof VegaCollapsibleTrigger>) {
  return (
    <VegaCollapsibleTrigger
      className={cn("group/studio-collapsible-trigger", className)}
      {...props}
    />
  );
}

function CollapsibleContent({
  className,
  ...props
}: ComponentProps<typeof VegaCollapsibleContent>) {
  return (
    <VegaCollapsibleContent
      className={cn(
        "h-(--collapsible-panel-height) overflow-hidden opacity-100 transition-[height,opacity] duration-(--tc-motion-standard) ease-(--tc-ease-standard) data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

function CollapsibleChevron({
  orientation = "down",
  className,
  ...props
}: LucideProps & { orientation?: "down" | "right" }) {
  const Icon = orientation === "right" ? ChevronRight : ChevronDown;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "shrink-0 transition-transform duration-(--tc-motion-standard) ease-(--tc-ease-standard) motion-reduce:transition-none",
        orientation === "right"
          ? "group-data-[panel-open]/studio-collapsible-trigger:rotate-90"
          : "group-data-[panel-open]/studio-collapsible-trigger:rotate-180",
        className,
      )}
      {...props}
    />
  );
}

export {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CollapsibleChevron,
};
