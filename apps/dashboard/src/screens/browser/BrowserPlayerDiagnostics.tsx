import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, Info, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { ReliabilityStatus } from "../../api/types";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useFormatLocale } from "../../i18n";
import { formatBytes } from "../../lib/formatBytes";
import {
  browserFacts,
  browserFindings,
  type Fact,
  type FactTone,
  type FindingSeverity,
} from "./browserDiagnostics";

const toneIcon: Record<FactTone, typeof CircleCheck> = {
  ok: CircleCheck,
  attention: TriangleAlert,
  muted: CircleDashed,
};

/**
 * What a Browser Player reports about itself, in words an operator can act
 * on. The facts are the Player's own measurements. Recommendations are sorted
 * by what they cost: a playback degradation first, then a setting that would
 * make the display more reliable, then how this kind of Player works.
 */
export function BrowserPlayerDiagnostics({
  screenId,
  screenStatus,
  playbackState,
  lastPlaybackError,
  reliability,
}: {
  screenId: string;
  screenStatus: string;
  playbackState?: string;
  lastPlaybackError?: string;
  reliability: ReliabilityStatus | undefined;
}) {
  const { t } = useTranslation("screens");
  const locale = useFormatLocale();
  // Shared with the managed-link panel, so this adds no request of its own.
  const slot = useQuery({
    queryKey: ["browser-slot", screenId],
    queryFn: () => api.browserPlayerSlot(screenId),
  });
  const input = {
    reliability,
    screenStatus,
    ...(playbackState ? { playbackState } : {}),
    ...(lastPlaybackError ? { lastPlaybackError } : {}),
    ...(slot.data ? { recoveryEnabled: slot.data.recoveryEnabled } : {}),
  };
  const facts = browserFacts(input, {
    bytes: (value) => formatBytes(value, locale),
  });
  const findings = browserFindings(input);
  const label = (fact: Fact) =>
    t(`browser.diagnostics.facts.${fact.id}` as never);
  const value = (fact: Fact) =>
    t(`browser.diagnostics.${fact.value}` as never, { ...fact.params });
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle>{t("browser.diagnostics.title")}</CardTitle>
        <CardDescription>{t("browser.diagnostics.body")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {findings.length > 0 && (
          <ul
            className="space-y-2"
            aria-label={t("browser.diagnostics.findingsLabel")}
          >
            {findings.map((finding) => (
              <li key={finding.id}>
                <FindingAlert id={finding.id} severity={finding.severity} />
              </li>
            ))}
          </ul>
        )}
        <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
          {facts.map((fact) => {
            const Icon = toneIcon[fact.tone];
            return (
              <div key={fact.id} className="min-w-0 space-y-1">
                <dt className="text-xs text-muted-foreground">{label(fact)}</dt>
                <dd className="flex items-start gap-1.5 break-words text-sm font-medium">
                  <Icon
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <span>{value(fact)}</span>
                </dd>
              </div>
            );
          })}
        </dl>
      </CardContent>
    </Card>
  );
}

function FindingAlert({
  id,
  severity,
}: {
  id: string;
  severity: FindingSeverity;
}) {
  const { t } = useTranslation("screens");
  const Icon = severity === "info" ? Info : TriangleAlert;
  return (
    <Alert variant={severity === "degraded" ? "destructive" : "default"}>
      <Icon aria-hidden="true" />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        {t(`browser.diagnostics.findings.${id}.title` as never)}
        <Badge variant={severity === "degraded" ? "destructive" : "outline"}>
          {t(`browser.diagnostics.severity.${severity}` as never)}
        </Badge>
      </AlertTitle>
      <AlertDescription>
        {t(`browser.diagnostics.findings.${id}.body` as never)}
      </AlertDescription>
    </Alert>
  );
}
