/*
 * The visual-trace sink for the Player Runtime (packages/player-runtime/src/
 * diagnostics/visual-trace.ts). Injected by tilecast-renderer-wpe only when
 * it runs with --visual-trace, at document start, top frame only, and only
 * on tilecast://runtime/index.html. Without that flag this file is never
 * loaded and the Runtime records nothing.
 *
 * It forwards trace batches, unchanged, through the native relay as a
 * "diagnostics.visual_trace" report. The renderer validates every record
 * again and writes it to its local trace file; nothing reaches tilecastd or
 * the network. A batch the relay could not carry is split, never truncated.
 */
(() => {
  "use strict";
  if (
    window.parent !== window ||
    location.href !== "tilecast://runtime/index.html"
  )
    return;
  const deep = globalThis.__tilecastVisualTraceDeep === true;
  try {
    delete globalThis.__tilecastVisualTraceDeep;
  } catch {}
  // The native relay refuses reports over 64 KiB.
  const LIMIT = 60000;
  const encoder = new TextEncoder();
  const send = (batch) => {
    const detail = JSON.stringify({ type: "diagnostics.visual_trace", batch });
    if (encoder.encode(detail).length <= LIMIT) {
      document.dispatchEvent(
        new CustomEvent("tilecast-native-report", { detail }),
      );
      return;
    }
    const records = batch.records;
    if (!Array.isArray(records) || records.length < 2) return;
    const half = Math.ceil(records.length / 2);
    send({ ...batch, records: records.slice(0, half) });
    send({ ...batch, dropped: 0, records: records.slice(half) });
  };
  const sink = Object.freeze({
    schema: "tilecast-visual-v1",
    deep,
    emit(batch) {
      try {
        send(batch);
      } catch {}
    },
  });
  Object.defineProperty(globalThis, "__tilecastVisualTrace", {
    value: sink,
    enumerable: false,
    configurable: false,
    writable: false,
  });
})();
