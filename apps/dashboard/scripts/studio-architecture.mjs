import ts from "typescript";

export const queryDomains = {
  screens: "screens",
  schedules: "schedules",
  "schedule-preview": "schedules",
  playlists: "playlists",
  layout: "layouts",
  layouts: "layouts",
  assets: "content",
  "content-definitions": "content",
  "content-folders": "content",
  "content-collections": "content",
  "content-tags": "content",
  activity: "activity",
};

function ancestor(node, predicate) {
  for (let current = node.parent; current; current = current.parent) {
    if (predicate(current)) return current;
  }
  return undefined;
}

function hasJSONRead(node) {
  if (!node) return false;
  let found = false;
  const visit = (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.name.text === "json"
    )
      found = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Structural guardrails; baseline comparison and CLI behavior belong to the scanner. */
export function scanArchitecture(file, source, migratedDomains = new Set()) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];
  const normalizedFile = file.replaceAll("\\", "/");
  const lines = source.split("\n");
  const report = (node, kind) => {
    const { line, character } = parsed.getLineAndCharacterOfPosition(
      node.getStart(parsed),
    );
    // An exception must explain a genuine boundary, such as a specialized upload.
    if (
      [lines[line], lines[line - 1]].some((text) =>
        /(?:\/\/|\/\*)\s*architecture-ignore:\s*\S/.test(text ?? ""),
      )
    )
      return;
    findings.push({
      line: line + 1,
      column: character + 1,
      kind,
      text: node.getText(parsed).replace(/\s+/g, " "),
    });
  };
  const checkKey = (node) => {
    if (normalizedFile.includes("/src/data/")) return;
    if (!ts.isArrayLiteralExpression(node)) return;
    const first = node.elements[0];
    if (
      first &&
      ts.isStringLiteral(first) &&
      migratedDomains.has(queryDomains[first.text])
    )
      report(node, "domain-query-key");
  };
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name?.getText(parsed) === "formatBytes" &&
      !normalizedFile.endsWith("/src/lib/formatBytes.ts")
    )
      report(node, "local-byte-formatter");
    if (ts.isClassDeclaration(node) && node.name?.text === "CancelledAction")
      report(node, "local-action-cancellation");
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "message" &&
      /\b(error|err|failure)\b/i.test(node.expression.getText(parsed))
    ) {
      const displayed = ancestor(
        node,
        (parent) =>
          ts.isJsxExpression(parent) ||
          (ts.isCallExpression(parent) &&
            /^toast\./.test(parent.expression.getText(parsed))),
      );
      if (displayed) report(node, "raw-error-feedback");
    }
    if (ts.isPropertyAssignment(node) && node.name.text === "queryKey")
      checkKey(node.initializer);
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(parsed);
      const first = node.arguments[0];
      if (/\.(getQueryData|setQueryData|removeQueries)$/.test(callee) && first)
        checkKey(first);
      if (
        callee === "request" &&
        node.typeArguments?.length &&
        first &&
        (ts.isStringLiteral(first) ||
          ts.isNoSubstitutionTemplateLiteral(first) ||
          ts.isTemplateExpression(first))
      ) {
        const route = ts.isTemplateExpression(first)
          ? first.head.text
          : first.text;
        if (route.startsWith("/") && !route.startsWith("/plugins/"))
          report(node, "static-generic-request");
      }
      if (
        ["fetch", "globalThis.fetch", "window.fetch"].includes(callee) &&
        !normalizedFile.endsWith("/src/api/transport.ts") &&
        first
      ) {
        const route = ts.isTemplateExpression(first)
          ? first.head.text
          : ts.isStringLiteral(first) ||
              ts.isNoSubstitutionTemplateLiteral(first)
            ? first.text
            : "";
        const owner = ancestor(node, (parent) => ts.isFunctionLike(parent));
        const options = node.arguments[1]?.getText(parsed) ?? "";
        if (
          route.startsWith("/api/v1") &&
          !route.startsWith("/api/v1/plugins/") &&
          (hasJSONRead(owner) ||
            /application\/json|JSON\.stringify/.test(options))
        )
          report(node, "untyped-core-json-fetch");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
}
