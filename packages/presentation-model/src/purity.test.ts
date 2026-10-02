import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps production decisions inside a pure dependency boundary", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const failures: string[] = [];
  const forbidden = new Set([
    "window",
    "document",
    "navigator",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "indexedDB",
    "localStorage",
    "setTimeout",
    "setInterval",
    "requestAnimationFrame",
    "process",
  ]);
  for (const file of readdirSync(root, { recursive: true }).filter(
    (name) =>
      typeof name === "string" &&
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts"),
  )) {
    const filename = resolve(root, String(file));
    const source = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const modulePath = (specifier: ts.Node | undefined) => {
      if (!specifier) return;
      if (
        !ts.isStringLiteral(specifier) ||
        !specifier.text.startsWith(".") ||
        !resolve(dirname(filename), specifier.text).startsWith(root + sep)
      )
        failures.push(`${file}: foreign import ${specifier.getText(source)}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        modulePath(node.moduleSpecifier);
      if (ts.isIdentifier(node) && forbidden.has(node.text))
        failures.push(`${file}: ${node.text}`);
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          modulePath(node.arguments[0]);
        if (
          ["Date.now", "Math.random", "require"].includes(
            node.expression.getText(source),
          )
        )
          failures.push(`${file}: ${node.expression.getText(source)}`);
      }
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(source) === "Date" &&
        !node.arguments?.length
      )
        failures.push(`${file}: implicit clock`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const manifest = JSON.parse(
    readFileSync(resolve(root, "../package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  expect(failures).toEqual([]);
});
