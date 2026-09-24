import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import type { TFunction } from "i18next";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { toast } from "../components/ui/toast";
import { activityRequest } from "../pages/ActivityShared";

type Retention = {
  rawEventDays: number;
  playbackSessionDays: number;
  screenStateDays: number;
  auditLogDays: number;
  diagnosticMetadataDays: number;
  updatedAt: string;
};

type RetentionNumberKey = Exclude<keyof Retention, "updatedAt">;

type RetentionFieldKey =
  | "retention.fields.rawEventDays"
  | "retention.fields.playbackSessionDays"
  | "retention.fields.screenStateDays"
  | "retention.fields.auditLogDays"
  | "retention.fields.diagnosticMetadataDays";

const fields: [RetentionNumberKey, RetentionFieldKey, number, number][] = [
  ["rawEventDays", "retention.fields.rawEventDays", 7, 365],
  ["playbackSessionDays", "retention.fields.playbackSessionDays", 30, 2555],
  ["screenStateDays", "retention.fields.screenStateDays", 30, 2555],
  ["auditLogDays", "retention.fields.auditLogDays", 90, 3650],
  ["diagnosticMetadataDays", "retention.fields.diagnosticMetadataDays", 7, 180],
];

type Draft = Record<RetentionNumberKey, string>;

type Validation =
  | { ok: true; payload: Record<RetentionNumberKey, number> }
  | { ok: false; errors: Partial<Record<RetentionNumberKey, string>> };

/**
 * The server enforces these bounds too. Checking them here keeps a rejected
 * value in the field the person is editing instead of returning it as a whole
 * failed request, and stops an emptied field from being sent as zero. The
 * schema is built at render so messages follow the interface language.
 */
function validate(
  draft: Draft,
  t: TFunction<["settings", "common"]>,
): Validation {
  const payload = {} as Record<RetentionNumberKey, number>;
  const errors: Partial<Record<RetentionNumberKey, string>> = {};
  for (const [key, labelKey, min, max] of fields) {
    const label = t(labelKey);
    const schema = z
      .string()
      .trim()
      .min(1, t("retention.validation.required", { label }))
      .regex(/^\d+$/, t("retention.validation.wholeDays", { label }))
      .transform(Number)
      .refine(
        (value) => value >= min && value <= max,
        t("retention.validation.range", { label, min, max }),
      );
    const result = schema.safeParse(draft[key]);
    if (result.success) payload[key] = result.data;
    else errors[key] = result.error.issues[0]?.message;
  }
  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, payload };
}

function draftFrom(value: Retention): Draft {
  return Object.fromEntries(
    fields.map(([key]) => [key, String(value[key])]),
  ) as Draft;
}

/**
 * How long Activity keeps each class of record. This is configuration rather
 * than reporting, so it lives with the other retention settings instead of on
 * the Activity page it governs.
 */
export function ActivityRetentionPanel({
  editable,
  onDirtyChange,
}: {
  editable: boolean;
  /** Lets Settings fold unsaved retention edits into its leave warning. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["activity", "retention"],
    queryFn: () => activityRequest<Retention>("/retention"),
    enabled: editable,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const persisted = query.data ? draftFrom(query.data) : null;
  const dirty = Boolean(
    draft && persisted && fields.some(([key]) => draft[key] !== persisted[key]),
  );

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const save = useMutation({
    mutationFn: async (input: Record<RetentionNumberKey, number>) => {
      const response = await fetch("/api/v1/activity/retention", {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": auth.status?.csrfToken ?? "",
        },
        body: JSON.stringify(input),
      });
      const body = (await response.json().catch(() => ({}))) as {
        data?: Retention;
        error?: { message?: string };
      };
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? t("retention.saveError"));
      return body.data;
    },
    onSuccess: (next) => {
      toast.add({
        title: "Activity retention settings saved.",
        type: "success",
      });
      setDraft(null);
      queryClient.setQueryData(["activity", "retention"], next);
    },
  });

  if (!editable) return null;

  const value = draft ?? persisted;
  const checked = value ? validate(value, t) : undefined;
  const errors = checked && !checked.ok ? checked.errors : {};

  return (
    <section
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
      aria-busy={query.isPending}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="grid gap-1">
          <h3 className="text-base font-semibold">{t("retention.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("retention.description")}
          </p>
        </div>
        {value && (
          <Button
            variant="default"
            type="button"
            disabled={save.isPending || !dirty || !checked?.ok}
            onClick={() => checked?.ok && save.mutate(checked.payload)}
          >
            {save.isPending ? t("common:actions.saving") : t("retention.save")}
          </Button>
        )}
      </header>

      {query.isPending && (
        <p className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm text-muted-foreground">
          {t("retention.loading")}
        </p>
      )}
      {query.error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {query.error instanceof Error
                ? query.error.message
                : t("retention.loadError")}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching
                ? t("retention.retrying")
                : t("retention.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}

      {value && (
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
          {fields.map(([key, labelKey, min, max]) => (
            <Field key={key}>
              <FieldLabel htmlFor={`retention-${key}`}>
                {t(labelKey)}
              </FieldLabel>
              <Input
                id={`retention-${key}`}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                value={value[key]}
                aria-invalid={errors[key] ? true : undefined}
                aria-describedby={`retention-${key}-hint`}
                onChange={(event) =>
                  setDraft({ ...value, [key]: event.target.value })
                }
              />
              <small
                id={`retention-${key}-hint`}
                className={
                  errors[key]
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {errors[key] ?? t("retention.rangeHint", { min, max })}
              </small>
            </Field>
          ))}
        </div>
      )}
    </section>
  );
}
