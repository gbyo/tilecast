import { useQuery } from "@tanstack/react-query";
import type { ConfigField } from "@tilecast/config-schema";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { connectionsClient, connectionsKey } from "./api";
import { connectionsRoute } from "./HostedConnectionsPage";
import { acceptedConnections } from "./model";

const NONE = "";

/**
 * A connection field: a choice among the plugin's connection records of a
 * declaration the field accepts. The value is the record's ID; an origin or
 * a credential never enters the configuration.
 */
export function HostedConnectionField({
  pluginId,
  manifest,
  field,
  label,
  description,
  value,
  readOnly,
  error,
  onChange,
}: {
  pluginId: string;
  manifest: PluginManifestV3;
  field: ConfigField;
  label: string;
  description?: string;
  value: unknown;
  readOnly: boolean;
  error?: string;
  onChange: (value: string | undefined) => void;
}) {
  const { t } = useTranslation("plugins");
  const connections = useQuery({
    queryKey: connectionsKey(pluginId),
    queryFn: connectionsClient(pluginId).list,
  });
  const options = acceptedConnections(
    connections.data?.items ?? [],
    field.connections,
  );
  const current = typeof value === "string" ? value : NONE;
  const selected = options.find((option) => option.id === current);
  const missing = current !== NONE && connections.isSuccess && !selected;
  const id = `connection-field-${field.key}`;
  const items = [
    ...(field.required
      ? []
      : [{ value: NONE, label: t("hosted.connections.field.none") }]),
    ...options.map((option) => ({ value: option.id, label: option.name })),
  ];
  return (
    <Field data-invalid={error || missing ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={current}
        disabled={readOnly || connections.isLoading}
        onValueChange={(next) => onChange(next ? next : undefined)}
      >
        <SelectTrigger
          id={id}
          aria-invalid={error || missing ? true : undefined}
        >
          <SelectValue>
            {selected?.name ??
              (current === NONE ? t("hosted.connections.field.none") : "")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value || "none"} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description && <FieldDescription>{description}</FieldDescription>}
      {connections.isSuccess && options.length === 0 && (
        <FieldDescription>
          {t("hosted.connections.field.empty")}
        </FieldDescription>
      )}
      <Link
        className="text-sm font-medium underline-offset-4 hover:underline"
        to={connectionsRoute(manifest)}
      >
        {t("hosted.connections.field.manage")}
      </Link>
      {missing && (
        <FieldError>{t("hosted.connections.field.missing")}</FieldError>
      )}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}
