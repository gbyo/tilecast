import { request, type FullConfig } from "@playwright/test";

// Waits for the server to report ready, then refuses to continue unless it is
// a Demo Mode installation: the suite resets data and must never be pointed
// at a real one.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("Playwright baseURL is not configured.");
  const context = await request.newContext({ baseURL });
  const deadline = Date.now() + 120_000;
  let lastError = "";
  for (;;) {
    try {
      const ready = await context.get("/readyz");
      if (ready.ok()) break;
      lastError = `readyz returned ${ready.status()}`;
    } catch (error) {
      lastError = String(error);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Tilecast at ${baseURL} did not become ready (${lastError}). Start it with \`make demo\`.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const status = await (await context.get("/api/v1/auth/status")).json();
  if (status?.data?.demoMode !== true) {
    throw new Error(
      `${baseURL} is not a Demo Mode installation. The E2E suite resets data and runs only against TILECAST_ENV=demo.`,
    );
  }
  await context.dispose();
}
