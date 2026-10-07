/**
 * What the screen shows while it rests outside active hours, from the
 * accepted Player configuration. The result is the Runtime's `sleep`
 * presentation. Whether the display also powers off is the host's decision.
 */

export type OutsideActiveHoursDisplay =
  "bouncing_logo" | "custom_text" | "black";

export interface OutsideActiveHoursPresentation {
  state: "sleep";
  display: OutsideActiveHoursDisplay;
  text: string;
  textColor: string;
}

interface ConfigurationSections {
  power?: Record<string, unknown>;
  branding?: Record<string, unknown>;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Unknown or missing modes fail safely to true black, and the text falls
 * back to the branding footer and then to the product line.
 */
export function buildOutsideActiveHoursPresentation(
  config: ConfigurationSections | null | undefined,
): OutsideActiveHoursPresentation {
  const power = config?.power ?? {};
  const branding = config?.branding ?? {};
  const configured = trimmed(power["outsideActiveHoursDisplay"]);
  const display: OutsideActiveHoursDisplay =
    configured === "bouncing_logo" || configured === "custom_text"
      ? configured
      : "black";
  return {
    state: "sleep",
    display,
    text:
      trimmed(power["outsideActiveHoursText"]) ||
      trimmed(branding["footerText"]) ||
      "Powered by Tilecast",
    textColor: trimmed(branding["textColor"]) || "#F5F7FA",
  };
}
