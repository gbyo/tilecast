import assert from "node:assert/strict";
import { test } from "node:test";
import { scanArchitecture } from "../../apps/dashboard/scripts/studio-architecture.mjs";

const page = "/repo/apps/dashboard/src/pages/Example.tsx";
const kinds = (source, file = page, domains = new Set()) =>
  scanArchitecture(file, source, domains).map((finding) => finding.kind);

test("local byte formatters and cancellation classes use shared owners", () => {
  assert.deepEqual(
    kinds(
      "function formatBytes(value: number) { return `${value} B`; } class CancelledAction extends Error {}",
    ),
    ["local-byte-formatter", "local-action-cancellation"],
  );
  assert.deepEqual(
    kinds("const formatBytes = (value: number) => `${value} B`;"),
    ["local-byte-formatter"],
  );
  assert.deepEqual(
    kinds(
      "export function formatBytes(value: number) {}",
      "/repo/apps/dashboard/src/lib/formatBytes.ts",
    ),
    [],
  );
  assert.deepEqual(
    kinds('import { formatBytes } from "../lib/formatBytes";'),
    [],
  );
});

test("raw errors in JSX and toast feedback fail; translated errors and logs do not", () => {
  assert.deepEqual(
    kinds(
      "const page = <Alert>{save.error.message}</Alert>; toast.add({ title: err.message });",
    ),
    ["raw-error-feedback", "raw-error-feedback"],
  );
  assert.deepEqual(
    kinds(
      'const page = <Alert>{apiErrorMessage(save.error, t)}</Alert>; toast.add({ title: t("saved") }); console.error(error.message);',
    ),
    [],
  );
});

test("query keys become authoritative when the domain exists and remain legal in its owner", () => {
  const source =
    'useQuery({ queryKey: ["screens", id] }); queryClient.setQueryData(["screens", id], data);';
  assert.deepEqual(kinds(source), []);
  assert.deepEqual(kinds(source, page, new Set(["screens"])), [
    "domain-query-key",
    "domain-query-key",
  ]);
  assert.deepEqual(
    kinds(
      'useQuery({ "queryKey": ["screens", id] });',
      page,
      new Set(["screens"]),
    ),
    ["domain-query-key"],
  );
  assert.deepEqual(
    kinds(
      source,
      "/repo/apps/dashboard/src/data/screens.ts",
      new Set(["screens"]),
    ),
    [],
  );
  assert.deepEqual(
    kinds(
      "useQuery(screenQueries.detail(id)); queryClient.setQueryData(screenKeys.detail(id), data);",
      page,
      new Set(["screens"]),
    ),
    [],
  );
});

test("static typed generic requests fail while runtime-discovered plugin routes remain dynamic", () => {
  assert.deepEqual(
    kinds(
      'request<Screen>(`/screens/${id}`); request<Users>("/users"); request<Plugin>(`/plugins/${plugin}/custom`); request<Result>(operation.path);',
    ),
    ["static-generic-request", "static-generic-request"],
  );
  assert.deepEqual(
    kinds(
      "async function operation() { const response = await fetch(`/api/v1/plugins/${plugin}/custom`); return response.json(); }",
    ),
    [],
  );
});

test("core JSON fetches fail while typed transport, external fetches and binary reads remain legal", () => {
  const jsonRead =
    'async function load() { const response = await fetch("/api/v1/screens"); return response.json(); }';
  assert.deepEqual(kinds(jsonRead), ["untyped-core-json-fetch"]);
  assert.deepEqual(
    kinds(jsonRead, "/repo/apps/dashboard/src/api/transport.ts"),
    [],
  );
  assert.deepEqual(
    kinds(
      'fetch("/api/v1/screens", { method: "POST", body: JSON.stringify(input) });',
    ),
    ["untyped-core-json-fetch"],
  );
  assert.deepEqual(
    kinds(
      'async function image() { const response = await fetch("/api/v1/previews/snapshot"); return response.blob(); } async function external() { const response = await fetch("https://example.invalid/data"); return response.json(); }',
    ),
    [],
  );
});

test("exceptions require a written reason and apply only to the adjacent finding", () => {
  assert.deepEqual(
    kinds(
      '// architecture-ignore: specialized multipart upload response\nasync function upload() { const response = await fetch("/api/v1/uploads"); return response.json(); }',
    ),
    [],
  );
  assert.deepEqual(
    kinds(
      "// architecture-ignore:\nconst page = <Alert>{error.message}</Alert>;",
    ),
    ["raw-error-feedback"],
  );
  assert.deepEqual(
    kinds(
      'const reason = "architecture-ignore: ordinary string";\nconst page = <Alert>{error.message}</Alert>;',
    ),
    ["raw-error-feedback"],
  );
  const finding = scanArchitecture(
    page,
    "\nconst page = <Alert>{error.message}</Alert>;",
  )[0];
  assert.equal(finding.line, 2);
  assert.equal(finding.text, "error.message");
});
