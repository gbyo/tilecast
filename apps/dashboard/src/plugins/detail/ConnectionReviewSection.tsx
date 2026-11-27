import { useTranslation } from "react-i18next";
import { Globe, Network, ShieldAlert } from "lucide-react";
import {
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import type { PluginConnectionReview } from "../../api/types";
import { formatBytes } from "../../plugin-host/hosted/connections/model";
import { DetailSection } from "./DetailSections";
import { ItemRow } from "./CapabilityItems";
import type { PluginDetailViewModel } from "./detailView";

const DEFAULT_RESPONSE = 1 << 20;
const DEFAULT_TIMEOUT = 10;

/** The security facts of one declared connection, as review lines. */
export function connectionReviewLines(
  connection: PluginConnectionReview,
  t: ReturnType<typeof useTranslation<"plugins">>["t"],
): { security: string[]; limits: string[] } {
  const security = [
    connection.operatorOrigin
      ? t("hosted.connections.review.operatorOrigin")
      : t("hosted.connections.review.fixedOrigins", {
          origins: connection.origins.join(", "),
        }),
  ];
  if (connection.privateNetwork)
    security.push(t("hosted.connections.review.privateNetwork"));
  if (connection.plainHttp)
    security.push(t("hosted.connections.review.plainHttp"));
  if (connection.plaintextSecret)
    security.push(t("hosted.connections.review.plaintextSecret"));
  const limits: string[] = [];
  if (connection.maxResponseBytes > DEFAULT_RESPONSE)
    limits.push(
      t("hosted.connections.review.response", {
        size: formatBytes(connection.maxResponseBytes),
      }),
    );
  if (connection.timeoutSeconds > DEFAULT_TIMEOUT)
    limits.push(
      t("hosted.connections.review.timeout", {
        seconds: connection.timeoutSeconds,
      }),
    );
  return { security, limits };
}

/**
 * What an included plugin's connections make possible, before install. The
 * security facts (where data can go, private network, plain HTTP, secrets
 * over plain HTTP) are separate from the title and description the plugin
 * writes about itself.
 */
export function ConnectionReviewSection({
  view,
}: {
  view: PluginDetailViewModel;
}) {
  const { t } = useTranslation("plugins");
  const connections = view.plugin?.connections ?? [];
  if (connections.length === 0) return null;
  return (
    <DetailSection
      id="detail-connections"
      title={t("hosted.connections.review.title")}
    >
      <ItemGroup render={<ul />} className="gap-0">
        {connections.map((connection, index) => {
          const { security, limits } = connectionReviewLines(connection, t);
          const sensitive = connection.privateNetwork || connection.plainHttp;
          return (
            <ItemRow key={connection.id} separated={index > 0}>
              <ItemMedia variant="icon">
                {connection.plaintextSecret || connection.plainHttp ? (
                  <ShieldAlert aria-hidden="true" />
                ) : sensitive ? (
                  <Network aria-hidden="true" />
                ) : (
                  <Globe aria-hidden="true" />
                )}
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{connection.title}</ItemTitle>
                {connection.description && (
                  <ItemDescription className="line-clamp-none">
                    {connection.description}
                  </ItemDescription>
                )}
                <p className="text-sm font-medium">
                  {t("hosted.connections.review.security")}
                </p>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {[...security, ...limits].map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </ItemContent>
            </ItemRow>
          );
        })}
      </ItemGroup>
    </DetailSection>
  );
}
