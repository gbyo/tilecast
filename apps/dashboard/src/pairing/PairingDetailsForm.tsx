import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { z } from "zod";
import type { UseFormReturn } from "react-hook-form";
import type { Location } from "../api/types";
import { FormField } from "../components/FormField";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/studio/StudioCollapsible";
import { Field, FieldLabel } from "../components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { useNativePresentation } from "../native-presentation/presentationContext";
import { formatLocationAddress } from "../settings/LocationsPanel";
import type { ApprovalForm, PairingT } from "./pairingFlow";

export const makeApprovalSchema = (t: PairingT) =>
  z.object({
    name: z.string().trim().min(2, t("approval.nameRequired")).max(120),
    locationId: z.string().optional(),
    roomName: z.string().max(120),
    roomNumber: z.string().max(80),
    description: z.string().max(1000),
  });

function CreateLocationLink() {
  const { t } = useTranslation("screens");
  const presentation = useNativePresentation();
  // Inside a native presentation the link leaves the sheet through the
  // generic presentation navigation instead of navigating the sheet's page.
  if (presentation) {
    return (
      <button
        type="button"
        className="w-fit cursor-pointer text-xs underline underline-offset-4"
        onClick={() => presentation.navigate("/settings/locations")}
      >
        {t("picker.createLocation")}
      </button>
    );
  }
  return (
    <Link
      className="w-fit text-xs underline underline-offset-4"
      to="/settings/locations"
    >
      {t("picker.createLocation")}
    </Link>
  );
}

export function LocationPicker({
  locations,
  value,
  onChange,
}: {
  locations: Location[];
  value?: string;
  onChange: (value?: string) => void;
}) {
  const { t } = useTranslation("screens");
  const selected = locations.find((location) => location.id === value);
  const items = [
    { value: "__unassigned__", label: t("shared.unassigned") },
    ...locations.map((location) => {
      const address = formatLocationAddress(location);
      return {
        value: location.id,
        label: address ? `${location.name} — ${address}` : location.name,
      };
    }),
  ];
  return (
    <Field className="gap-2">
      <FieldLabel htmlFor="screen-location" className="text-sm font-medium">
        {t("picker.locationLabel")}
      </FieldLabel>
      <Select
        items={items}
        value={value ?? "__unassigned__"}
        onValueChange={(next) =>
          onChange(next === "__unassigned__" || !next ? undefined : next)
        }
      >
        <SelectTrigger id="screen-location" className="w-full">
          <SelectValue placeholder={t("shared.unassigned")} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected && formatLocationAddress(selected) && (
        <small className="text-xs text-muted-foreground">
          {formatLocationAddress(selected)}
        </small>
      )}
      <CreateLocationLink />
    </Field>
  );
}

/**
 * The concise new-screen form: name and location up front, room and
 * description behind a disclosure. Only a genuinely new logical screen
 * needs it; repair and replacement never render it.
 */
export function PairingDetailsForm({
  form,
  locations,
}: {
  form: UseFormReturn<ApprovalForm>;
  locations: Location[];
}) {
  const { t } = useTranslation("screens");
  return (
    <div className="grid gap-4">
      <FormField
        id="screenName"
        label={t("approval.nameLabel")}
        error={form.formState.errors.name?.message}
        {...form.register("name")}
      />
      <LocationPicker
        locations={locations}
        value={form.watch("locationId")}
        onChange={(locationId) =>
          form.setValue("locationId", locationId, { shouldDirty: true })
        }
      />
      <Collapsible>
        <CollapsibleTrigger className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t("details.moreDetails")}
          <CollapsibleChevron />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-4 pt-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                id="screenRoomName"
                label={t("approval.roomName")}
                placeholder={t("approval.roomNamePlaceholder")}
                {...form.register("roomName")}
              />
              <FormField
                id="screenRoomNumber"
                label={t("approval.roomNumber")}
                placeholder={t("approval.roomNumberPlaceholder")}
                {...form.register("roomNumber")}
              />
            </div>
            <Field>
              <FieldLabel htmlFor="screenDescription">
                {t("approval.description")}
              </FieldLabel>
              <Textarea
                id="screenDescription"
                {...form.register("description")}
              />
            </Field>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
