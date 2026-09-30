import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { buttonVariants } from "../ui/button";
import { headerAction } from "./layout";

/**
 * The one header action every Overview card and rail section uses: quiet
 * text, a trailing chevron, and a right edge on the same column as the row
 * chevrons below it.
 */
export function HeaderLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      className={buttonVariants({
        variant: "ghost",
        size: "xs",
        className: `${headerAction} text-muted-foreground hover:text-foreground`,
      })}
      to={to}
    >
      {label}
      <ChevronRight aria-hidden="true" data-icon="inline-end" />
    </Link>
  );
}
