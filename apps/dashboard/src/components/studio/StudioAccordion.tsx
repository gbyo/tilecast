import { cn } from "cn";
import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger as BaseAccordionTrigger,
} from "../ui/accordion";

function AccordionTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseAccordionTrigger>) {
  return (
    <BaseAccordionTrigger
      className={cn("**:data-[slot=accordion-trigger-icon]:hidden", className)}
      {...props}
    >
      {children}
      <ChevronDown
        aria-hidden="true"
        className="ms-auto size-4 shrink-0 text-muted-foreground transition-transform duration-(--tc-motion-standard) ease-(--tc-ease-standard) group-aria-expanded/accordion-trigger:rotate-180 motion-reduce:transition-none"
      />
    </BaseAccordionTrigger>
  );
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
