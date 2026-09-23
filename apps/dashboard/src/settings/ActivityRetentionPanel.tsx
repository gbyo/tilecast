import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button as RheaButton } from "../components/ui/button";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
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

const fields: [RetentionNumberKey, string, number, number][] = [
  ["rawEventDays", "Raw Player activity events", 7, 365],
  ["playbackSessionDays", "Proof-of-play sessions", 30, 2555],
  ["screenStateDays", "Screen state intervals", 30, 2555],
  ["auditLogDays", "Audit logs", 90, 3650],
  ["diagnosticMetadataDays", "Detailed diagnostic metadata", 7, 180],
];

/**
 * The server enforces these bounds too. Checking them here keeps a rejected
 * value in the field the person is editing instead of returning it as a whole
 * failed request, and stops an emptied field from being sent as zero.
 */
const fieldSchemas = new Map(
  fields.map(([key, label, min, max]) => [
    key,
    z
      .string()
      .trim()
      .min(1, `${label} is required.`)
      .regex(/^\d+$/, `${label} must be a whole number of days.`)
      .transform(Number)
      .refine(
        (value) => value >= min && value <= max,
        `${label} must be between ${min} and ${max} days.`,
      ),
  ]),
);

type Draft = Record<RetentionNumberKey, string>;

type Validation =
  | { ok: true; payload: Record<RetentionNumberKey, number> }
  | { ok: false; errors: Partial<Record<RetentionNumberKey, string>> };

function validate(draft: Draft): Validation {
  const payload = {} as Record<RetentionNumberKey, number>;
  const errors: Partial<Record<RetentionNumberKey, string>> = {};
  for (const [key] of fields) {
    const result = fieldSchemas.get(key)!.safeParse(draft[key]);
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
        throw new Error(
          body.error?.message ?? "Retention settings could not be saved.",
        );
      return body.data;
    },
    onSuccess: (next) => {
      setDraft(null);
      queryClient.setQueryData(["activity", "retention"], next);
    },
  });

  if (!editable) return null;

  const value = draft ?? persisted;
  const checked = value ? validate(value) : undefined;
  const errors = checked && !checked.ok ? checked.errors : {};

  return (
    <section
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
      aria-busy={query.isPending}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="grid gap-1">
          <h3 className="text-base font-semibold">Activity retention</h3>
          <p className="text-sm text-muted-foreground">
            Cleanup runs in bounded background batches and respects deployment
            hard limits.
          </p>
        </div>
        {value && (
          <RheaButton
            variant="default"
            type="button"
            disabled={save.isPending || !dirty || !checked?.ok}
            onClick={() => checked?.ok && save.mutate(checked.payload)}
          >
            {save.isPending ? "Saving…" : "Save retention"}
          </RheaButton>
        )}
      </header>

      {query.isPending && (
        <p className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm text-muted-foreground">
          Loading retention settings…
        </p>
      )}
      {query.error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {query.error instanceof Error
                ? query.error.message
                : "Retention settings could not be loaded."}
            </span>
            <RheaButton
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching ? "Retrying…" : "Try again"}
            </RheaButton>
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
          {fields.map(([key, label, min, max]) => (
            <Field key={key}>
              <FieldLabel htmlFor={`retention-${key}`}>{label}</FieldLabel>
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
                {errors[key] ?? `${min}–${max} days`}
              </small>
            </Field>
          ))}
        </div>
      )}
    </section>
  );
}
