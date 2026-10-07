declare const __RUNTIME_PATH__: string;

/**
 * Registers the service worker and loads the unchanged production Runtime
 * artifact. Resolves when the worker controls the page. The Host never asks a
 * waiting worker to activate during playback.
 */
export async function registerShell(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(
    "/player/service-worker.js",
    { scope: "/player", updateViaCache: "none" },
  );
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => resolve(),
        { once: true },
      );
    });
  }
  return registration;
}

/** Appends the Runtime's own document, style and script. The page owns nothing else. */
export function loadRuntime(): void {
  const base = document.createElement("base");
  base.href = `${__RUNTIME_PATH__}/`;
  document.head.append(base);
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = `${__RUNTIME_PATH__}/runtime.css`;
  document.head.append(css);
  const script = document.createElement("script");
  script.src = `${__RUNTIME_PATH__}/runtime.js`;
  document.head.append(script);
}
