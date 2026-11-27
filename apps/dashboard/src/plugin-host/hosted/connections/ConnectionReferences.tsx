import { useTranslation } from "react-i18next";
import type { PluginConnection } from "./api";

/** The settings and instances that use a connection. */
export function ConnectionReferences({
  connection,
}: {
  connection: PluginConnection;
}) {
  const { t } = useTranslation("plugins");
  return (
    <section className="grid gap-2" aria-labelledby="connection-references">
      <h2 id="connection-references" className="text-base font-semibold">
        {t("hosted.connections.referencesTitle")}
      </h2>
      {connection.references.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("hosted.connections.noReferences")}
        </p>
      ) : (
        <>
          <ul className="grid gap-1 text-sm">
            {connection.references.map((reference) => (
              <li
                key={`${reference.ownerType}-${reference.ownerId}-${reference.fieldKey}`}
              >
                {reference.ownerType === "settings"
                  ? t("hosted.connections.referenceSettings")
                  : reference.label}
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            {t("hosted.connections.inUseHint")}
          </p>
        </>
      )}
    </section>
  );
}
