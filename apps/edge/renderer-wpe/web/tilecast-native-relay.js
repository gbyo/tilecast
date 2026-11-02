/* Injected into the private Tilecast script world, trusted top document only. */
(() => {
  "use strict";
  if (
    window.parent !== window ||
    location.href !== "tilecast://runtime/index.html"
  )
    return;
  const handlers = globalThis.webkit && globalThis.webkit.messageHandlers;
  if (!handlers || !handlers.tilecast || !handlers.tilecastRequest) return;
  const bytes = (value) => new TextEncoder().encode(value).length;
  const emit = (value) =>
    document.dispatchEvent(
      new CustomEvent("tilecast-native-answer", {
        detail: JSON.stringify(value),
      }),
    );
  let pending = 0;
  document.addEventListener("tilecast-native-report", (event) => {
    if (
      event.target !== document ||
      typeof event.detail !== "string" ||
      bytes(event.detail) > 65536
    )
      return;
    try {
      handlers.tilecast.postMessage(JSON.parse(event.detail));
    } catch {}
  });
  document.addEventListener("tilecast-native-request", (event) => {
    if (
      event.target !== document ||
      typeof event.detail !== "string" ||
      bytes(event.detail) > 65536
    )
      return;
    let request;
    try {
      request = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (
      !request ||
      !Number.isSafeInteger(request.id) ||
      request.id < 1 ||
      !request.message ||
      typeof request.message !== "object"
    )
      return;
    if (pending >= 8) {
      emit({ id: request.id, ok: false });
      return;
    }
    pending++;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      pending--;
      clearTimeout(timer);
      try {
        emit(value);
      } catch {
        emit({ id: request.id, ok: false });
      }
    };
    const timer = setTimeout(
      () => finish({ id: request.id, ok: false }),
      60000,
    );
    Promise.resolve()
      .then(() => handlers.tilecastRequest.postMessage(request.message))
      .then(
        (value) => {
          try {
            const raw = JSON.stringify(value);
            finish(
              raw && bytes(raw) <= 65500
                ? { id: request.id, ok: true, value }
                : { id: request.id, ok: false },
            );
          } catch {
            finish({ id: request.id, ok: false });
          }
        },
        () => finish({ id: request.id, ok: false }),
      );
  });
})();
