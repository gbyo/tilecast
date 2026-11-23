import { zodResolver } from "@hookform/resolvers/zod";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { originText, parseOrigin } from "@tilecast/plugin-sdk/connections";
import { useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ConnectionWrite, PluginConnection } from "./api";

type Declaration = PluginManifestV3["connections"][number];

export interface GeneralValues {
  definition: string;
  name: string;
  origin: string;
}

interface Messages {
  nameRequired: string;
  originRequired: string;
  originInvalid: string;
  originHttps: string;
}

function schemaFor(declarations: readonly Declaration[], messages: Messages) {
  return z
    .object({
      definition: z.string().min(1),
      name: z.string().trim().min(1, messages.nameRequired).max(120),
      origin: z.string(),
    })
    .superRefine((values, context) => {
      const declaration = declarations.find(
        (item) => item.id === values.definition,
      );
      if (declaration?.origins !== "operator") return;
      if (values.origin.trim() === "") {
        context.addIssue({
          code: "custom",
          path: ["origin"],
          message: messages.originRequired,
        });
        return;
      }
      const origin = parseOrigin(values.origin);
      if (!origin) {
        context.addIssue({
          code: "custom",
          path: ["origin"],
          message: messages.originInvalid,
        });
      } else if (
        origin.scheme === "http" &&
        declaration.plainHttp !== "allowed"
      ) {
        context.addIssue({
          code: "custom",
          path: ["origin"],
          message: messages.originHttps,
        });
      }
    });
}

/** The request body for a save, with the origin written canonically. */
export function generalWrite(
  values: GeneralValues,
  declaration: Declaration | undefined,
  revision?: number,
): ConnectionWrite {
  const body: ConnectionWrite = {
    definition: values.definition,
    name: values.name.trim(),
  };
  if (declaration?.origins === "operator") {
    const origin = parseOrigin(values.origin);
    body.origin = origin ? originText(origin) : values.origin.trim();
  }
  if (revision !== undefined) body.expectedRevision = revision;
  return body;
}

/**
 * The name and the origin of a connection, and for a new one its kind. This
 * form never carries a consent: those save separately.
 */
export function ConnectionGeneralForm({
  declarations,
  connection,
  readOnly,
  pending,
  onSubmit,
}: {
  declarations: readonly Declaration[];
  connection?: PluginConnection;
  readOnly: boolean;
  pending: boolean;
  onSubmit: (values: GeneralValues) => void;
}) {
  const { t } = useTranslation("plugins");
  const resolver = useMemo(
    () =>
      zodResolver(
        schemaFor(declarations, {
          nameRequired: t("hosted.connections.nameRequired"),
          originRequired: t("hosted.connections.originRequired"),
          originInvalid: t("hosted.connections.originInvalid"),
          originHttps: t("hosted.connections.originHttps"),
        }),
      ),
    [declarations, t],
  );
  const form = useForm<GeneralValues>({
    resolver,
    values: {
      definition: connection?.definition ?? declarations[0]?.id ?? "",
      name: connection?.name ?? "",
      origin: connection?.origin ?? "",
    },
  });
  const { control, register, handleSubmit, formState, watch } = form;
  const definition = watch("definition");
  const declaration = declarations.find((item) => item.id === definition);
  const errors = formState.errors;
  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      {connection === undefined && declarations.length > 1 && (
        <Field>
          <FieldLabel htmlFor="connection-definition">
            {t("hosted.connections.definition")}
          </FieldLabel>
          <Controller
            control={control}
            name="definition"
            render={({ field }) => (
              <Select
                items={declarations.map((item) => ({
                  value: item.id,
                  label: item.title,
                }))}
                value={field.value}
                onValueChange={(next) => next && field.onChange(next)}
                disabled={readOnly}
              >
                <SelectTrigger id="connection-definition">
                  <SelectValue>{declaration?.title}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {declarations.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldDescription>
            {t("hosted.connections.definitionHint")}
          </FieldDescription>
        </Field>
      )}
      {declaration?.description && (
        <p className="text-sm text-muted-foreground">
          {declaration.description}
        </p>
      )}
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor="connection-name">
          {t("hosted.connections.name")}
        </FieldLabel>
        <Input
          id="connection-name"
          maxLength={120}
          disabled={readOnly}
          aria-invalid={errors.name ? true : undefined}
          {...register("name")}
        />
        {errors.name && <FieldError>{errors.name.message}</FieldError>}
      </Field>
      {declaration?.origins === "operator" ? (
        <Field data-invalid={errors.origin ? true : undefined}>
          <FieldLabel htmlFor="connection-origin">
            {t("hosted.connections.origin")}
          </FieldLabel>
          <Input
            id="connection-origin"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            maxLength={300}
            disabled={readOnly}
            aria-describedby="connection-origin-hint"
            aria-invalid={errors.origin ? true : undefined}
            {...register("origin")}
          />
          <FieldDescription id="connection-origin-hint">
            {t("hosted.connections.originHint")}
          </FieldDescription>
          {errors.origin && <FieldError>{errors.origin.message}</FieldError>}
        </Field>
      ) : (
        declaration && (
          <div className="grid gap-1 text-sm">
            <span className="font-medium">
              {t("hosted.connections.approvedOrigins")}
            </span>
            <ul className="text-muted-foreground">
              {declaration.origins.map((origin) => (
                <li key={origin}>{origin}</li>
              ))}
            </ul>
          </div>
        )
      )}
      {!readOnly && (
        <div>
          <Button type="submit" disabled={pending}>
            {connection
              ? t("hosted.connections.save")
              : t("hosted.connections.create")}
          </Button>
        </div>
      )}
    </form>
  );
}
