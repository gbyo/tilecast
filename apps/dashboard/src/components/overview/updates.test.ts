import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import { deployment } from "./fixtures";
import { summarizeUpdates, updateDeploymentStatusKey } from "./updates";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("summarizeUpdates", () => {
  it("has nothing to say without deployments", () => {
    expect(summarizeUpdates([])).toBeUndefined();
  });

  it("is quiet after a fully successful deployment", () => {
    expect(summarizeUpdates([deployment()])).toMatchObject({
      needsAction: 0,
      failed: 0,
      waiting: 0,
    });
  });

  it("counts failures and screens waiting on a person in the latest deployment", () => {
    expect(
      summarizeUpdates([
        deployment({
          failedCount: 2,
          waitingForUserCount: 1,
          status: "active",
        }),
      ]),
    ).toMatchObject({ failed: 2, waiting: 1, needsAction: 3 });
  });

  it("ignores a failure from an older deployment that a newer one replaced", () => {
    const summary = summarizeUpdates([
      deployment({
        id: "old",
        createdAt: "2026-06-01T00:00:00Z",
        failedCount: 5,
      }),
      deployment({ id: "new", createdAt: "2026-09-20T00:00:00Z" }),
    ]);
    expect(summary?.deployment.id).toBe("new");
    expect(summary?.needsAction).toBe(0);
  });

  it("still counts an older deployment that is in progress", () => {
    const summary = summarizeUpdates([
      deployment({
        id: "old",
        createdAt: "2026-09-01T00:00:00Z",
        status: "paused",
        failedCount: 1,
      }),
      deployment({ id: "new", createdAt: "2026-09-20T00:00:00Z" }),
    ]);
    expect(summary?.needsAction).toBe(1);
    expect(summary?.deployment.id).toBe("old");
  });
});

describe("updateDeploymentStatusKey", () => {
  it("translates deployment statuses in the active locale", async () => {
    await i18n.loadNamespaces("activity");
    await i18n.changeLanguage("es");
    expect(
      i18n.t(updateDeploymentStatusKey("completed"), { ns: "activity" }),
    ).toBe("Completada");
  });

  it("uses a localized fallback for a status a newer server adds", async () => {
    await i18n.loadNamespaces("activity");
    await i18n.changeLanguage("ru");
    expect(
      i18n.t(updateDeploymentStatusKey("future_status"), { ns: "activity" }),
    ).toBe("Неизвестный статус");
  });
});
