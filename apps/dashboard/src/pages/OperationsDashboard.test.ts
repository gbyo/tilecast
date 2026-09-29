import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { updateDeploymentStatusKey } from "./OperationsDashboard";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("Operations player update status labels", () => {
  it("translates deployment statuses in the active locale", async () => {
    await i18n.loadNamespaces("activity");
    await i18n.changeLanguage("es");

    expect(
      i18n.t(updateDeploymentStatusKey("completed"), { ns: "activity" }),
    ).toBe("Completada");
  });

  it("uses a localized fallback for an unknown status", async () => {
    await i18n.loadNamespaces("activity");
    await i18n.changeLanguage("ru");

    expect(
      i18n.t(updateDeploymentStatusKey("future_status"), { ns: "activity" }),
    ).toBe("Неизвестный статус");
  });
});
