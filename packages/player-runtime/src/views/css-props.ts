/**
 * A strict-CSP replacement for Lit's styleMap.
 *
 * styleMap writes a `style` attribute string on first render, which a
 * document with `style-src 'self'` (and no 'unsafe-inline') refuses. This
 * directive only ever uses the CSSOM (`style.setProperty` and
 * `removeProperty`), which the policy allows, and removes properties that
 * disappear between renders.
 */
import { noChange } from "lit";
import {
  Directive,
  directive,
  PartType,
  type AttributePart,
  type PartInfo,
} from "lit/directive.js";

export type CssProps = Record<string, string | null | undefined>;

class CssPropsDirective extends Directive {
  private previous = new Set<string>();

  constructor(part: PartInfo) {
    super(part);
    if (part.type !== PartType.ATTRIBUTE || part.name !== "style") {
      throw new Error("cssProps must be bound to the style attribute");
    }
  }

  render(_props: CssProps): typeof noChange {
    return noChange;
  }

  override update(part: AttributePart, [props]: [CssProps]): typeof noChange {
    const style = (part.element as HTMLElement).style;
    const next = new Set<string>();
    for (const [name, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;
      next.add(name);
      style.setProperty(name, value);
    }
    for (const name of this.previous) {
      if (!next.has(name)) style.removeProperty(name);
    }
    this.previous = next;
    return noChange;
  }
}

export const cssProps = directive(CssPropsDirective);
