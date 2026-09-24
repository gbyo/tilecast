import type { VariantProps } from "class-variance-authority";
import type { badgeVariants } from "../components/ui/badge";

export type FormStatusTone =
  "success" | "info" | "warning" | "danger" | "neutral";

/**
 * Maps a workflow status tone to Base Vega Badge props. The label text always
 * carries the meaning; color is an enhancement, never the only signal.
 */
export function formToneBadgeProps(
  tone: FormStatusTone,
): VariantProps<typeof badgeVariants> & { className?: string } {
  switch (tone) {
    case "success":
      return {
        variant: "outline",
        className:
          "border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-400",
      };
    case "info":
      return {
        variant: "outline",
        className:
          "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
      };
    case "warning":
      return {
        variant: "outline",
        className:
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      };
    case "danger":
      return { variant: "destructive" };
    case "neutral":
    default:
      return { variant: "secondary" };
  }
}
