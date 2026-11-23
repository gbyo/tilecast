import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiErrorMessage, useFormatLocale } from "@/i18n";
import { useStudioSession } from "../../session";
import {
  feedRecordsKey,
  feedsClient,
  feedsKey,
  type PluginFeedField,
  type PluginFeedRecord,
} from "./api";
import { draftText, hasOverride, overridable, overrideValue } from "./model";

const policyKey = {
  upstream: "hosted.feeds.policy.upstream",
  local: "hosted.feeds.policy.local",
  local_until_changed: "hosted.feeds.policy.local_until_changed",
} as const satisfies Record<PluginFeedField["override"], string>;

const removalKey = {
  upstream_changed: "hosted.feeds.removed.upstream_changed",
  feed_version_changed: "hosted.feeds.removed.feed_version_changed",
  retention: "hosted.feeds.removed.retention",
} as const;

const imageFailureKey = {
  http_refused: "hosted.feeds.imageFailure.http_refused",
  auth_required: "hosted.feeds.imageFailure.auth_required",
  fetch_failed: "hosted.feeds.imageFailure.fetch_failed",
  invalid_image: "hosted.feeds.imageFailure.invalid_image",
  image_too_large: "hosted.feeds.imageFailure.image_too_large",
  processing_failed: "hosted.feeds.imageFailure.processing_failed",
  quota_exceeded: "hosted.feeds.imageFailure.quota_exceeded",
} as const;

/**
 * One record: for each field the upstream value, the operator's override,
 * the effective value, the policy, and why an override disappeared. Only a
 * local or local_until_changed field takes an override, saved one field at
 * a time.
 */
export function FeedRecordDialog({
  pluginId,
  datasetId,
  fields,
  record,
  onClose,
}: {
  pluginId: string;
  datasetId: string;
  fields: PluginFeedField[];
  record: PluginFeedRecord;
  onClose: () => void;
}) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((field) => [
        field.key,
        draftText(record.overrides[field.key]),
      ]),
    ),
  );
  const save = useMutation({
    mutationFn: ({ field, value }: { field: string; value: unknown }) =>
      feedsClient(pluginId).override(
        datasetId,
        { recordId: record.id, field, value },
        session.csrfToken,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: feedRecordsKey(pluginId, datasetId),
      });
      void queryClient.invalidateQueries({ queryKey: feedsKey(pluginId) });
    },
  });
  const readOnly = !session.canManage || save.isPending;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("hosted.feeds.recordTitle", { id: record.id })}
          </DialogTitle>
          <DialogDescription>
            {t("hosted.feeds.recordDescription")}
          </DialogDescription>
        </DialogHeader>
        {save.isError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
          </Alert>
        )}
        {fields.map((field) => {
          const id = `override-${field.key}`;
          const removal = record.removedOverrides[field.key];
          const failure = record.imageFailures[field.key];
          const reason =
            removal && removal.reason in removalKey
              ? removalKey[removal.reason as keyof typeof removalKey]
              : undefined;
          const imageFailure =
            failure && failure in imageFailureKey
              ? imageFailureKey[failure as keyof typeof imageFailureKey]
              : undefined;
          return (
            <FieldSet key={field.key} className="grid gap-2 border-b pb-3">
              <FieldLegend className="flex flex-wrap items-center gap-2">
                {field.label}
                <Badge variant="secondary">
                  {t(policyKey[field.override])}
                </Badge>
                {field.personal && (
                  <Badge variant="outline">{t("hosted.feeds.personal")}</Badge>
                )}
                {hasOverride(record, field.key) && (
                  <Badge>{t("hosted.feeds.overridden")}</Badge>
                )}
              </FieldLegend>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">
                  {t("hosted.feeds.upstream")}
                </dt>
                <dd className="break-words">
                  {field.image
                    ? t("hosted.feeds.imageFromProvider")
                    : draftText(record.upstream[field.key]) || "—"}
                </dd>
                <dt className="text-muted-foreground">
                  {t("hosted.feeds.effective")}
                </dt>
                <dd className="break-words">
                  {field.image
                    ? record.effective[field.key]
                      ? t("hosted.feeds.imageReady")
                      : t("hosted.feeds.imageMissing")
                    : record.effective[field.key] || "—"}
                </dd>
              </dl>
              {reason && removal && (
                <p className="text-sm text-muted-foreground" role="status">
                  {t(reason, {
                    date: new Date(removal.removedAt).toLocaleString(locale),
                  })}
                </p>
              )}
              {imageFailure && (
                <p className="text-sm text-destructive" role="status">
                  {t(imageFailure)}
                </p>
              )}
              {overridable(field) && (
                <Field>
                  <FieldLabel htmlFor={id}>
                    {t("hosted.feeds.local")}
                  </FieldLabel>
                  <FieldDescription id={`${id}-description`}>
                    {field.override === "local"
                      ? t("hosted.feeds.localHint")
                      : t("hosted.feeds.localUntilChangedHint")}
                  </FieldDescription>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id={id}
                      className="min-w-0 flex-1"
                      value={drafts[field.key] ?? ""}
                      maxLength={field.maxLength}
                      disabled={readOnly}
                      aria-describedby={`${id}-description`}
                      onChange={(event) =>
                        setDrafts({
                          ...drafts,
                          [field.key]: event.target.value,
                        })
                      }
                    />
                    {session.canManage && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={readOnly}
                          onClick={() =>
                            save.mutate({
                              field: field.key,
                              value: overrideValue(
                                field,
                                drafts[field.key] ?? "",
                              ),
                            })
                          }
                        >
                          {t("hosted.feeds.saveOverride")}
                        </Button>
                        {hasOverride(record, field.key) && (
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={readOnly}
                            onClick={() => {
                              setDrafts({ ...drafts, [field.key]: "" });
                              save.mutate({ field: field.key, value: null });
                            }}
                          >
                            {t("hosted.feeds.clearOverride")}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </Field>
              )}
            </FieldSet>
          );
        })}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("hosted.feeds.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
