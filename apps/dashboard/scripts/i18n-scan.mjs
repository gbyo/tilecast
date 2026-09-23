#!/usr/bin/env node
// Lists user-visible English that has not moved into a locale file yet.
//
//   npm run i18n:scan                         every finding under src/
//   npm run i18n:scan -- --summary            counts per file, largest first
//   npm run i18n:scan -- --check src/pages/UsersPage.tsx
//                                             exit 1 if that file has any
//
// It is a heuristic, not a proof: it reports JSX text, translatable JSX
// attributes, string literals rendered from JSX expressions, toast and
// confirm messages, and label-like object properties. A literal that must
// stay English (a code sample, a protocol value) is silenced by putting
// `i18n-ignore` in a comment on the same line or the line above.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const summary = args.includes("--summary");
const check = args.includes("--check");
const targets = args.filter((arg) => !arg.startsWith("--"));
if (targets.length === 0) targets.push("src");

const translatableAttributes = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "cancelLabel",
  "confirmLabel",
  "description",
  "emptyMessage",
  "eyebrow",
  "heading",
  "helper",
  "hint",
  "label",
  "message",
  "placeholder",
  "subtitle",
  "summary",
  "title",
  "tooltip",
]);
const translatableProperties = new Set([
  ...translatableAttributes,
  "ariaLabel",
  "body",
  "detail",
  "emptyText",
  "emptyTitle",
  "text",
]);
const messageCalls = new Set(["alert", "confirm", "prompt"]);
const toastMethods = new Set([
  "error",
  "info",
  "loading",
  "message",
  "success",
  "warning",
]);

function files(target) {
  const absolute = path.resolve(root, target);
  if (!fs.existsSync(absolute)) {
    console.error(`i18n-scan: no such path ${target}`);
    process.exit(2);
  }
  if (fs.statSync(absolute).isFile()) return [absolute];
  return fs
    .readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|d)\.tsx?$/.test(file));
}

/** Looks like prose rather than a class name, key, or enum value. */
function isProse(text) {
  const value = text.trim();
  if (!/\p{L}/u.test(value)) return false;
  if (/^(https?:|mailto:|\/|#|\.\/|[\w-]+\.\w{2,4}$)/.test(value)) return false;
  return /\s/.test(value) || /^\p{Lu}/u.test(value) || /[…’]/.test(value);
}

function isTranslationCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : "";
  return ["t", "translateKnown", "Trans", "useTranslation"].includes(name);
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)]
      .join("…")
      .trim();
  }
  return null;
}

function attributeName(node) {
  return ts.isIdentifier(node.name) ? node.name.text : node.name.getText();
}

/** Why a string literal is user-visible, or null if it is not. */
function literalContext(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isTranslationCall(current)) return null;
    if (ts.isJsxAttribute(current)) {
      return translatableAttributes.has(attributeName(current))
        ? `attribute ${attributeName(current)}`
        : null;
    }
    if (ts.isJsxExpression(current)) {
      if (ts.isJsxAttribute(current.parent)) {
        const name = attributeName(current.parent);
        return translatableAttributes.has(name) ? `attribute ${name}` : null;
      }
      return ts.isJsxElement(current.parent) || ts.isJsxFragment(current.parent)
        ? "jsx expression"
        : null;
    }
    if (ts.isPropertyAssignment(current) && current.initializer === node) {
      const name = current.name.getText().replace(/^["']|["']$/g, "");
      return translatableProperties.has(name) ? `property ${name}` : null;
    }
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isIdentifier(callee) && messageCalls.has(callee.text)) {
        return `${callee.text}()`;
      }
      if (ts.isIdentifier(callee) && callee.text === "toast") return "toast()";
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ["toast", "window"].includes(callee.expression.text) &&
        (toastMethods.has(callee.name.text) ||
          messageCalls.has(callee.name.text))
      ) {
        return `${callee.getText()}()`;
      }
      return null;
    }
    // Stop at boundaries past which a literal no longer feeds this JSX.
    if (
      ts.isFunctionLike(current) ||
      ts.isVariableDeclaration(current) ||
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isElementAccessExpression(current) ||
      (ts.isBinaryExpression(current) &&
        current.operatorToken.kind !== ts.SyntaxKind.BarBarToken &&
        current.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken &&
        current.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken &&
        current.operatorToken.kind !== ts.SyntaxKind.PlusToken)
    ) {
      return null;
    }
  }
  return null;
}

function scan(file) {
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split("\n");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];
  const report = (node, kind, text) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    if (/i18n-ignore/.test(`${lines[line - 1] ?? ""}${lines[line]}`)) return;
    findings.push({ line: line + 1, column: character + 1, kind, text });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (/\p{L}/u.test(text)) report(node, "jsx text", text);
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = attributeName(node);
      if (
        translatableAttributes.has(name) &&
        ts.isStringLiteral(node.initializer) &&
        isProse(node.initializer.text)
      ) {
        report(node, `attribute ${name}`, node.initializer.text);
      }
    } else {
      const text = literalText(node);
      if (text !== null && !ts.isJsxAttribute(node.parent) && isProse(text)) {
        const kind = literalContext(node);
        if (kind) report(node, kind, text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

const results = targets
  .flatMap(files)
  .map((file) => ({ file: path.relative(root, file), findings: scan(file) }))
  .filter((result) => result.findings.length > 0);
const total = results.reduce((sum, r) => sum + r.findings.length, 0);

if (summary) {
  for (const { file, findings } of results.sort(
    (a, b) => b.findings.length - a.findings.length,
  )) {
    console.log(`${String(findings.length).padStart(5)}  ${file}`);
  }
} else {
  for (const { file, findings } of results) {
    for (const finding of findings) {
      const text =
        finding.text.length > 70
          ? `${finding.text.slice(0, 69)}…`
          : finding.text;
      console.log(
        `${file}:${finding.line}:${finding.column}  ${finding.kind}  ${JSON.stringify(text)}`,
      );
    }
  }
}
console.log(
  `${total} untranslated string${total === 1 ? "" : "s"} in ${results.length} file${results.length === 1 ? "" : "s"}`,
);
if (check && total > 0) process.exit(1);
