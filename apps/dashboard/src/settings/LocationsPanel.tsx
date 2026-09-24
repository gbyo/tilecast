import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Location, LocationInput } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { DashboardSearch } from "../components/DashboardListToolbar";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";

const emptyLocation: LocationInput = {
  name: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "",
};

export function formatLocationAddress(location?: Partial<Location>) {
  if (!location) return "";
  return [
    location.addressLine1,
    location.addressLine2,
    [location.city, location.state].filter(Boolean).join(", "),
    location.postalCode,
    location.country,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function LocationsPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const client = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const query = useQuery({ queryKey: ["locations"], queryFn: api.locations });
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Location | "new">();
  const [form, setForm] = useState<LocationInput>(emptyLocation);
  const [notice, setNotice] = useState<string>();
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (query.data?.items ?? []).filter((location) =>
      `${location.name} ${formatLocationAddress(location)}`
        .toLowerCase()
        .includes(needle),
    );
  }, [query.data, search]);
  const save = useMutation({
    mutationFn: () =>
      editing === "new"
        ? api.createLocation(form, auth.status?.csrfToken ?? "")
        : api.updateLocation(
            editing?.id ?? "",
            form,
            auth.status?.csrfToken ?? "",
          ),
    onSuccess: async () => {
      toast.add({
        title: t("locations.saved"),
        type: "success",
      });
      setEditing(undefined);
      await client.invalidateQueries({ queryKey: ["locations"] });
      await client.invalidateQueries({ queryKey: ["screens"] });
    },
  });
  const remove = useMutation({
    mutationFn: (location: Location) =>
      api.deleteLocation(location.id, auth.status?.csrfToken ?? ""),
    onSuccess: async () => {
      toast.add({ title: t("locations.deleted"), type: "success" });
      await client.invalidateQueries({ queryKey: ["locations"] });
    },
    onError: (error) =>
      setNotice(
        error instanceof ApiError && error.status === 409
          ? t("locations.deleteConflict")
          : error instanceof Error
            ? error.message
            : t("locations.deleteFailed"),
      ),
  });
  const open = (location: Location | "new") => {
    setNotice(undefined);
    setEditing(location);
    setForm(
      location === "new"
        ? emptyLocation
        : {
            name: location.name,
            addressLine1: location.addressLine1,
            addressLine2: location.addressLine2,
            city: location.city,
            state: location.state,
            postalCode: location.postalCode,
            country: location.country,
            latitude: location.latitude,
            longitude: location.longitude,
          },
    );
  };
  return (
    <>
      {confirmDialog}
      <section className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <DashboardSearch
            value={search}
            onValueChange={setSearch}
            label={t("locations.searchLabel")}
            placeholder={t("locations.searchPlaceholder")}
          />
          {canManage && (
            <Button variant="default" onClick={() => open("new")}>
              <Plus size={16} aria-hidden="true" /> {t("locations.add")}
            </Button>
          )}
        </div>
        {notice && (
          <Alert role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {query.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {t("locations.loadError")} {query.error.message}
            </AlertDescription>
          </Alert>
        )}
        {query.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            {t("locations.loading")}
          </p>
        ) : query.isError ? null : (
          <ItemGroup className="gap-2">
            {matches.map((location) => (
              <Item key={location.id} variant="outline">
                <ItemMedia
                  variant="icon"
                  className="size-8 rounded-lg bg-muted"
                >
                  <MapPin size={17} aria-hidden="true" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{location.name}</ItemTitle>
                  <ItemDescription>
                    {formatLocationAddress(location) ||
                      t("locations.noAddress")}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="flex-wrap">
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {t("locations.screens", { count: location.screenCount })}
                  </span>
                  {canManage && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("locations.editLocation", {
                          name: location.name,
                        })}
                        onClick={() => open(location)}
                      >
                        <Pencil size={16} aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("locations.deleteLocation", {
                          name: location.name,
                        })}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (location.screenCount > 0) {
                            void confirm({
                              title: t("locations.blockedTitle", {
                                name: location.name,
                              }),
                              action: t("locations.confirmOk"),
                            });
                            return;
                          }
                          void confirm({
                            title: t("locations.deleteTitle", {
                              name: location.name,
                            }),
                            action: t("common:actions.delete"),
                            destructive: true,
                          }).then((ok) => {
                            if (ok) remove.mutate(location);
                          });
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </Button>
                    </>
                  )}
                </ItemActions>
              </Item>
            ))}
            {!matches.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MapPin size={24} aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>
                    {search ? t("locations.emptySearch") : t("locations.empty")}
                  </EmptyTitle>
                  <EmptyDescription>
                    {search
                      ? t("locations.emptySearchHint")
                      : t("locations.emptyHint")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </ItemGroup>
        )}
        <Dialog
          open={Boolean(editing)}
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {editing === "new"
                  ? t("locations.addTitle")
                  : t("locations.editTitle")}
              </DialogTitle>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
            >
              <LocationField
                id="location-name"
                labelKey="locations.fields.name"
                required
                value={form.name}
                onChange={(name) => setForm({ ...form, name })}
              />
              <LocationField
                id="location-address-1"
                labelKey="locations.fields.address1"
                value={form.addressLine1}
                onChange={(addressLine1) => setForm({ ...form, addressLine1 })}
              />
              <LocationField
                id="location-address-2"
                labelKey="locations.fields.address2"
                value={form.addressLine2}
                onChange={(addressLine2) => setForm({ ...form, addressLine2 })}
              />
              <div className="grid gap-4 sm:grid-cols-3">
                <LocationField
                  id="location-city"
                  labelKey="locations.fields.city"
                  value={form.city}
                  onChange={(city) => setForm({ ...form, city })}
                />
                <LocationField
                  id="location-state"
                  labelKey="locations.fields.state"
                  value={form.state}
                  onChange={(state) => setForm({ ...form, state })}
                />
                <LocationField
                  id="location-postal-code"
                  labelKey="locations.fields.postal"
                  value={form.postalCode}
                  onChange={(postalCode) => setForm({ ...form, postalCode })}
                />
              </div>
              <LocationField
                id="location-country"
                labelKey="locations.fields.country"
                value={form.country}
                onChange={(country) => setForm({ ...form, country })}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <LocationField
                  id="location-latitude"
                  labelKey="locations.fields.latitude"
                  type="number"
                  value={form.latitude ?? ""}
                  onChange={(value) =>
                    setForm({
                      ...form,
                      latitude: value === "" ? undefined : Number(value),
                    })
                  }
                />
                <LocationField
                  id="location-longitude"
                  labelKey="locations.fields.longitude"
                  type="number"
                  value={form.longitude ?? ""}
                  onChange={(value) =>
                    setForm({
                      ...form,
                      longitude: value === "" ? undefined : Number(value),
                    })
                  }
                />
              </div>
              {save.error && (
                <Alert variant="destructive">
                  <AlertDescription>{save.error.message}</AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setEditing(undefined)}
                >
                  {t("common:actions.cancel")}
                </Button>
                <Button
                  variant="default"
                  type="submit"
                  disabled={!form.name.trim() || save.isPending}
                >
                  {save.isPending
                    ? t("common:actions.saving")
                    : t("locations.save")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </section>
    </>
  );
}

type LocationFieldLabelKey =
  | "locations.fields.name"
  | "locations.fields.address1"
  | "locations.fields.address2"
  | "locations.fields.city"
  | "locations.fields.state"
  | "locations.fields.postal"
  | "locations.fields.country"
  | "locations.fields.latitude"
  | "locations.fields.longitude";

function LocationField({
  id,
  labelKey,
  value,
  onChange,
  required,
  type = "text",
}: {
  id: string;
  labelKey: LocationFieldLabelKey;
  value: string | number;
  onChange: (value: string) => void;
  required?: boolean;
  type?: "text" | "number";
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t(labelKey)}</FieldLabel>
      <Input
        id={id}
        type={type}
        step={type === "number" ? "any" : undefined}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
