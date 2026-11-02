import { useTranslation } from "react-i18next";
import {
  capabilityGroupOf,
  capabilityGroupOrder,
  capabilityMessageKey,
} from "./capabilitySelection";

/**
 * What a role lets someone do, by Studio area, in plain language. Shown next
 * to the role picker so choosing a role is choosing outcomes, not a name.
 */
export function RoleCapabilitySummary({
  capabilities,
}: {
  capabilities: readonly string[];
}) {
  const { t } = useTranslation("account");
  const translate = t as unknown as (
    key: string,
    options?: Record<string, unknown>,
  ) => string;
  const groups = capabilityGroupOrder
    .map((group) => ({
      group,
      items: capabilities.filter((key) => capabilityGroupOf(key) === group),
    }))
    .filter((entry) => entry.items.length > 0);
  if (!groups.length)
    return (
      <p className="text-sm text-muted-foreground">
        {t("roleAdmin.summary.none")}
      </p>
    );
  return (
    <dl className="grid gap-2 rounded-lg border border-border p-3 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-x-4">
      {groups.map(({ group, items }) => (
        <div key={group} className="contents">
          <dt className="font-medium">
            {translate(`roleAdmin.groups.${group}`)}
          </dt>
          <dd className="text-muted-foreground">
            {items
              .map((key) =>
                translate(
                  `roleAdmin.capabilities.${capabilityMessageKey(key)}.label`,
                  {
                    defaultValue: key,
                  },
                ),
              )
              .join(", ")}
          </dd>
        </div>
      ))}
    </dl>
  );
}
