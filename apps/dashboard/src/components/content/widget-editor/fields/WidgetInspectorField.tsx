/**
 * One inspector control, chosen from the field's declared control type and
 * authoring hints. Every control is a Field with a programmatic label,
 * description, required state, and error. There are no provider-specific
 * controls: the vocabulary is the definition schema's, nothing more.
 */
import { authoringUiOf } from "@tilecast/widget-sdk";
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { DateInput, DateTimeInput } from "@/components/date-picker";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { localDateTimeToRfc3339, rfc3339ToLocalDateTime } from "@/lib/dateTime";
import { useOrganizationRegionalProfile } from "@/settings/regionalProfile";
import { timezoneLabel, timezoneOptions } from "@/settings/settingValues";
import {
  controlAria,
  fieldDomId,
  fieldText,
  type InspectorFieldProps,
} from "./fieldContext";
import { InspectorFieldFrame } from "./InspectorFieldFrame";
import { WidgetDataSourceField } from "./WidgetDataSourceField";
import { WidgetFieldMapping } from "./WidgetFieldMapping";
import { WidgetMediaField } from "./WidgetMediaField";
import { WidgetRepeatingField } from "./WidgetRepeatingField";

export function WidgetInspectorField(props: InspectorFieldProps) {
  const { field } = props;
  switch (field.control) {
    case "data_source":
      return <WidgetDataSourceField {...props} />;
    case "data_source_field":
      return <WidgetFieldMapping {...props} />;
    case "media_asset":
      return <WidgetMediaField {...props} />;
    case "repeating_group":
      return <WidgetRepeatingField {...props} />;
    case "boolean":
      return <BooleanField {...props} />;
    case "select":
      return authoringUiOf(field).styleCard ? (
        <ChoiceField {...props} />
      ) : (
        <SelectField {...props} />
      );
    default:
      return <StandardField {...props} />;
  }
}

function BooleanField({
  field,
  path,
  value,
  onChange,
  readOnly,
  errorFor,
}: InspectorFieldProps) {
  const error = errorFor(path);
  const aria = controlAria(path, field, error);
  return (
    <Field orientation="horizontal" data-invalid={error ? true : undefined}>
      <FieldContent>
        <FieldLabel htmlFor={aria.id}>{field.label}</FieldLabel>
        {field.description && (
          <FieldDescription id={`${aria.id}-description`}>
            {field.description}
          </FieldDescription>
        )}
        {error && <FieldError id={`${aria.id}-error`}>{error}</FieldError>}
      </FieldContent>
      <Switch
        {...aria}
        checked={value === true}
        disabled={readOnly}
        onCheckedChange={(checked) => onChange(checked === true)}
      />
    </Field>
  );
}

function SelectField({
  field,
  path,
  value,
  onChange,
  readOnly,
  errorFor,
}: InspectorFieldProps) {
  const { t } = useTranslation("content");
  const error = errorFor(path);
  const aria = controlAria(path, field, error);
  const options = field.options ?? [];
  const items = field.required
    ? options
    : [{ value: "", label: t("widgets.editor.fields.none") }, ...options];
  return (
    <InspectorFieldFrame path={path} field={field} error={error}>
      <Select
        value={fieldText(value)}
        disabled={readOnly}
        onValueChange={(next) => onChange(next ?? "")}
        items={items}
      >
        <SelectTrigger {...aria} className="w-full">
          <SelectValue placeholder={t("widgets.editor.fields.choose")} />
        </SelectTrigger>
        <SelectContent>
          {items.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </InspectorFieldFrame>
  );
}

/** A select whose options read best as visible choices. */
function ChoiceField({
  field,
  path,
  value,
  onChange,
  readOnly,
  errorFor,
}: InspectorFieldProps) {
  const error = errorFor(path);
  const id = fieldDomId(path);
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldTitle id={`${id}-label`}>{field.label}</FieldTitle>
      {field.description && (
        <FieldDescription id={`${id}-description`}>
          {field.description}
        </FieldDescription>
      )}
      <RadioGroup
        id={id}
        aria-labelledby={`${id}-label`}
        aria-describedby={
          [
            field.description ? `${id}-description` : "",
            error ? `${id}-error` : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-required={field.required || undefined}
        aria-invalid={error ? true : undefined}
        value={fieldText(value)}
        disabled={readOnly}
        onValueChange={(next) => onChange(next)}
        className="grid grid-cols-2 gap-2"
      >
        {(field.options ?? []).map((option) => {
          const optionId = `${id}-${option.value}`;
          return (
            <FieldLabel key={option.value} htmlFor={optionId}>
              <Field orientation="horizontal" className="gap-2 p-2.5">
                <FieldContent>
                  <FieldTitle>{option.label}</FieldTitle>
                </FieldContent>
                <RadioGroupItem value={option.value} id={optionId} />
              </Field>
            </FieldLabel>
          );
        })}
      </RadioGroup>
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

function StandardField(props: InspectorFieldProps) {
  const { field, path, errorFor } = props;
  const error = errorFor(path);
  if (field.control === "string_list")
    return (
      <InspectorFieldFrame
        path={path}
        field={field}
        error={error}
        labelFor={`${fieldDomId(path)}-0`}
      >
        <StringListControl {...props} error={error} />
      </InspectorFieldFrame>
    );
  return (
    <InspectorFieldFrame path={path} field={field} error={error}>
      <StandardControl {...props} error={error} />
    </InspectorFieldFrame>
  );
}

function StandardControl({
  field,
  path,
  value,
  onChange,
  readOnly,
  error,
}: InspectorFieldProps & { error: string | undefined }) {
  const { t } = useTranslation(["content", "schedules"]);
  const aria = controlAria(path, field, error);
  const common = { ...aria, disabled: readOnly, required: field.required };
  switch (field.control) {
    case "multiline_text":
      return (
        <Textarea
          {...common}
          value={fieldText(value)}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "number":
    case "integer":
      return (
        <NumberControl
          field={field}
          value={value}
          onChange={onChange}
          common={common}
        />
      );
    case "color":
      return (
        <ColorControl
          field={field}
          value={fieldText(value)}
          onChange={onChange}
          common={common}
        />
      );
    case "date":
      return (
        <DateInput
          {...aria}
          disabled={readOnly}
          required={field.required}
          value={fieldText(value)}
          onChange={onChange}
        />
      );
    case "datetime":
      return (
        <DateTimeInput
          {...aria}
          disabled={readOnly}
          required={field.required}
          timeLabel={t("datePicker.time", { ns: "schedules" })}
          value={rfc3339ToLocalDateTime(fieldText(value))}
          onChange={(next) => onChange(localDateTimeToRfc3339(next))}
        />
      );
    case "local_datetime":
      // A wall-clock time a sibling timezone field interprets: shown and
      // saved as entered, never converted to an instant.
      return (
        <DateTimeInput
          {...aria}
          disabled={readOnly}
          required={field.required}
          timeLabel={t("datePicker.time", { ns: "schedules" })}
          value={fieldText(value).slice(0, 16)}
          onChange={onChange}
        />
      );
    case "timezone":
      return (
        <TimezoneControl
          field={field}
          value={fieldText(value)}
          onChange={onChange}
          aria={aria}
          disabled={readOnly}
        />
      );
    case "currency_code":
      return (
        <Input
          {...common}
          value={fieldText(value).toUpperCase()}
          maxLength={3}
          autoCapitalize="characters"
          className="w-24 uppercase"
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
      );
    default:
      return (
        <Input
          {...common}
          type={field.control === "url" ? "url" : "text"}
          inputMode={field.control === "url" ? "url" : undefined}
          value={fieldText(value)}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

type CommonControlProps = ReturnType<typeof controlAria> & {
  disabled: boolean;
  required?: boolean;
};

function NumberControl({
  field,
  value,
  onChange,
  common,
}: {
  field: InspectorFieldProps["field"];
  value: unknown;
  onChange: (value: unknown) => void;
  common: CommonControlProps;
}) {
  const numeric = typeof value === "number" ? value : undefined;
  const input = (
    <Input
      {...common}
      type="number"
      inputMode={field.control === "integer" ? "numeric" : "decimal"}
      min={field.minimum}
      max={field.maximum}
      step={field.control === "integer" ? 1 : "any"}
      value={numeric ?? ""}
      className={authoringUiOf(field).slider ? "w-24" : undefined}
      onChange={(event) =>
        onChange(
          event.target.value === "" ? undefined : Number(event.target.value),
        )
      }
    />
  );
  const sliding =
    authoringUiOf(field).slider &&
    field.minimum !== undefined &&
    field.maximum !== undefined;
  if (!sliding) return input;
  return (
    <div className="flex items-center gap-3">
      <Slider
        min={field.minimum}
        max={field.maximum}
        step={field.control === "integer" ? 1 : 0.1}
        value={[numeric ?? field.minimum!]}
        disabled={common.disabled}
        // The slider and the input edit one value under one label.
        aria-labelledby={`${common.id}-label`}
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
        className="flex-1"
      />
      {input}
    </div>
  );
}

function ColorControl({
  field,
  value,
  onChange,
  common,
}: {
  field: InspectorFieldProps["field"];
  value: string;
  onChange: (value: unknown) => void;
  common: CommonControlProps;
}) {
  const { t } = useTranslation("content");
  const swatch = /^#[0-9a-fA-F]{6}/.test(value) ? value.slice(0, 7) : "#000000";
  return (
    <InputGroup>
      <InputGroupAddon>
        <input
          type="color"
          aria-label={t("widgets.editor.fields.pickColor", {
            label: field.label,
          })}
          disabled={common.disabled}
          value={swatch}
          onChange={(event) => onChange(event.target.value)}
          className="size-5 cursor-pointer rounded-sm border-0 bg-transparent p-0 disabled:cursor-not-allowed"
        />
      </InputGroupAddon>
      <InputGroupInput
        {...common}
        value={value}
        placeholder={
          field.required ? "#000000" : t("widgets.editor.fields.themeColor")
        }
        maxLength={9}
        spellCheck={false}
        className="font-mono"
        onChange={(event) => onChange(event.target.value.trim())}
      />
      {!field.required && value && !common.disabled && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={t("widgets.editor.fields.clearColor", {
              label: field.label,
            })}
            onClick={() => onChange("")}
          >
            <X aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/**
 * Searchable IANA zones. An empty value means the organization's zone,
 * which the Widget resolves at play time.
 */
function TimezoneControl({
  field,
  value,
  onChange,
  aria,
  disabled,
}: {
  field: InspectorFieldProps["field"];
  value: string;
  onChange: (value: unknown) => void;
  aria: ReturnType<typeof controlAria>;
  disabled: boolean;
}) {
  const { t } = useTranslation("content");
  const regional = useOrganizationRegionalProfile();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const organization = t("widgets.editor.fields.organizationZone", {
    zone: regional.timezone ?? "UTC",
  });
  const zones = useMemo(
    () => [...(field.required ? [] : [""]), ...timezoneOptions(value)],
    [field.required, value],
  );
  const label = (zone: string) =>
    zone === "" ? organization : timezoneLabel(zone);
  const filtered = zones.filter((zone) =>
    label(zone).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Combobox
      items={zones}
      filteredItems={filtered}
      value={value}
      open={open}
      inputValue={open ? search : label(value)}
      disabled={disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
      itemToStringLabel={label}
      onInputValueChange={setSearch}
    >
      <ComboboxInput
        {...aria}
        placeholder={t("widgets.editor.fields.searchZones")}
      />
      <ComboboxContent>
        <ComboboxEmpty>{t("widgets.editor.fields.noZones")}</ComboboxEmpty>
        <ComboboxList>
          {(zone: string) => (
            <ComboboxItem key={zone || "organization"} value={zone}>
              {label(zone)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/** A bounded list of short text entries, such as host names. */
function StringListControl({
  field,
  path,
  value,
  onChange,
  readOnly,
  error,
}: InspectorFieldProps & { error: string | undefined }) {
  const { t } = useTranslation("content");
  const items = Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry : ""))
    : [];
  const id = fieldDomId(path);
  const limit = field.maximumItems ?? Infinity;
  const describedBy =
    [field.description ? `${id}-description` : "", error ? `${id}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="grid gap-2" id={id} role="group">
      {items.map((entry, index) => (
        <InputGroup key={index}>
          <InputGroupInput
            id={`${id}-${index}`}
            aria-label={t("widgets.editor.fields.listEntry", {
              label: field.label,
              index: index + 1,
            })}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            value={entry}
            disabled={readOnly}
            maxLength={field.maxLength}
            spellCheck={false}
            onChange={(event) =>
              onChange(
                items.map((current, position) =>
                  position === index ? event.target.value : current,
                ),
              )
            }
          />
          {!readOnly && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label={t("widgets.editor.fields.removeEntry", {
                  label: field.label,
                  index: index + 1,
                })}
                onClick={() =>
                  onChange(items.filter((_, position) => position !== index))
                }
              >
                <X aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      ))}
      {!readOnly && items.length < limit && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          id={items.length === 0 ? `${id}-0` : undefined}
          onClick={() => onChange([...items, ""])}
        >
          <Plus aria-hidden="true" />
          {t("widgets.editor.fields.addEntry")}
        </Button>
      )}
      {readOnly && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("widgets.editor.fields.noEntries")}
        </p>
      )}
    </div>
  );
}
