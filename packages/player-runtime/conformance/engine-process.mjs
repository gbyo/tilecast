import { createRequire } from "node:module";

// Electron 42 downloads its binary when its package entry point is loaded.
// Resolve through that entry point rather than guessing a dist path or .cmd shim.
export function electronExecutable(
  override,
  load = createRequire(import.meta.url),
) {
  return override ?? load("electron");
}

export function engineFailure(child, result) {
  if (child.error) {
    return `process startup failed (${child.error.code ?? "unknown"}): ${child.error.message}`;
  }
  if (child.signal) return `process terminated by ${child.signal}`;
  if (result?.failure) return result.failure;
  if (child.status !== 0) return `process exited with code ${child.status}`;
  return result ? null : "no result";
}
