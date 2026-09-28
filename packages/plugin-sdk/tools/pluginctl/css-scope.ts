/**
 * Plugin runtime stylesheets are appended to the one Player stylesheet, so a
 * plugin's rules must not reach another plugin or the Player's own UI. Every
 * selector starts with the plugin's class, `.tc-<dir>`, optionally followed
 * by a BEM element or modifier (`__part`, `--state`); every keyframes name
 * starts with `tc-<dir>-`. Rules that are global by nature (@import,
 * @font-face, @property, @layer, :root) are refused.
 */

const GROUPING_AT_RULES = new Set(["media", "supports", "container"]);
const KEYFRAMES = new Set(["keyframes", "-webkit-keyframes"]);

export function checkCssScope(css: string, dir: string): string[] {
  const problems: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectorPrefix = new RegExp(
    `^\\.tc-${escape(dir)}(?:$|__|--|[\\s.:#\\[>+~])`,
  );
  const keyframesPrefix = `tc-${dir}-`;

  const block = (start: number): number => {
    // Index just past the brace that closes the block opened at start.
    // Braces inside quoted strings are content, not structure.
    let depth = 0;
    let quote = "";
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quote) {
        if (character === "\\") index += 1;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    problems.push("unbalanced braces");
    return text.length;
  };

  const scan = (from: number, to: number): void => {
    let index = from;
    while (index < to) {
      const open = text.indexOf("{", index);
      const semicolon = text.indexOf(";", index);
      if (open < 0 || open >= to) {
        const rest = text.slice(index, to).trim();
        if (rest.startsWith("@")) {
          problems.push(`${rest.split(/[\s;]/)[0]} is not allowed`);
        } else if (rest) problems.push(`unexpected text: ${rest.slice(0, 40)}`);
        return;
      }
      const prelude = text.slice(index, open).trim();
      if (prelude.startsWith("@") && semicolon >= 0 && semicolon < open) {
        problems.push(`${prelude.split(/[\s;]/)[0]} is not allowed`);
        index = semicolon + 1;
        continue;
      }
      const end = block(open);
      if (prelude.startsWith("@")) {
        const [, name = "", rest = ""] =
          /^@([-\w]+)\s*([\s\S]*)$/.exec(prelude) ?? [];
        if (GROUPING_AT_RULES.has(name)) {
          scan(open + 1, end - 1);
        } else if (KEYFRAMES.has(name)) {
          if (!rest.trim().startsWith(keyframesPrefix)) {
            problems.push(
              `@keyframes ${rest.trim()} must be named ${keyframesPrefix}…`,
            );
          }
        } else {
          problems.push(`@${name} is not allowed`);
        }
      } else {
        for (const selector of splitSelectors(prelude)) {
          if (!selectorPrefix.test(selector)) {
            problems.push(`selector "${selector}" must start with .tc-${dir}`);
          } else if (hasSiblingCombinator(selector)) {
            problems.push(
              `selector "${selector}" must not use sibling combinators`,
            );
          }
        }
        if (hasNestedRule(text.slice(open + 1, end - 1))) {
          problems.push(`nested rules are not allowed in "${prelude}"`);
        }
      }
      index = end;
    }
  };

  scan(0, text.length);
  return problems;
}

/**
 * A + or ~ at the top level of a selector reaches a sibling outside the
 * plugin's subtree. The same characters inside attribute selectors, quoted
 * strings, or functional expressions are values, not combinators.
 */
function hasSiblingCombinator(selector: string): boolean {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if ((character === "+" || character === "~") && depth === 0) {
      return true;
    }
  }
  return false;
}

/** A block opener inside a style rule body starts a nested rule. */
function hasNestedRule(body: string): boolean {
  let quote = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") return true;
  }
  return false;
}

function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of prelude) {
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (character === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
