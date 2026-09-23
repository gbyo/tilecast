import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
        title: editing === "new" ? "Location created." : "Location updated.",
        type: "success",
      });
      setEditing(undefined);
      setNotice("Location saved.");
      await client.invalidateQueries({ queryKey: ["locations"] });
      await client.invalidateQueries({ queryKey: ["screens"] });
    },
  });
  const remove = useMutation({
    mutationFn: (location: Location) =>
      api.deleteLocation(location.id, auth.status?.csrfToken ?? ""),
    onSuccess: async () => {
      toast.add({ title: "Location deleted.", type: "success" });
      setNotice("Location deleted.");
      await client.invalidateQueries({ queryKey: ["locations"] });
    },
    onError: (error) =>
      setNotice(
        error instanceof ApiError && error.status === 409
          ? "This location still has screens assigned. Reassign or unassign them before deleting it."
          : error instanceof Error
            ? error.message
            : "The location could not be deleted.",
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
            label="Search locations"
            placeholder="Search by name or address"
          />
          {canManage && (
            <Button variant="default" onClick={() => open("new")}>
              <Plus size={16} aria-hidden="true" /> Add location
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
              Location data failed to load. {query.error.message}
            </AlertDescription>
          </Alert>
        )}
        {query.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            Loading locations…
          </p>
        ) : (
          <div className="grid gap-2">
            {matches.map((location) => (
              <article
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4"
                key={location.id}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-muted">
                  <MapPin size={17} aria-hidden="true" />
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="text-sm font-semibold">
                    {location.name}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {formatLocationAddress(location) || "No address set"}
                  </small>
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {location.screenCount} screen
                  {location.screenCount === 1 ? "" : "s"}
                </span>
                {canManage && (
                  <span className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${location.name}`}
                      onClick={() => open(location)}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${location.name}`}
                      disabled={remove.isPending}
                      onClick={() => {
                        if (location.screenCount > 0) {
                          void confirm({
                            title: `${location.name} still has screens assigned and cannot be deleted.`,
                            action: "OK",
                          });
                          return;
                        }
                        void confirm({
                          title: `Delete ${location.name}?`,
                          action: "Delete",
                          destructive: true,
                        }).then((ok) => {
                          if (ok) remove.mutate(location);
                        });
                      }}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </span>
                )}
              </article>
            ))}
            {!matches.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MapPin size={24} aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>
                    {search ? "No locations match" : "No locations yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {search
                      ? "Try a different name or address."
                      : "Add a building or campus to assign it to screens."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
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
                {editing === "new" ? "Add location" : "Edit location"}
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
                label="Location name"
                required
                value={form.name}
                onChange={(name) => setForm({ ...form, name })}
              />
              <LocationField
                id="location-address-1"
                label="Address line 1"
                value={form.addressLine1}
                onChange={(addressLine1) => setForm({ ...form, addressLine1 })}
              />
              <LocationField
                id="location-address-2"
                label="Address line 2"
                value={form.addressLine2}
                onChange={(addressLine2) => setForm({ ...form, addressLine2 })}
              />
              <div className="grid gap-4 sm:grid-cols-3">
                <LocationField
                  id="location-city"
                  label="City"
                  value={form.city}
                  onChange={(city) => setForm({ ...form, city })}
                />
                <LocationField
                  id="location-state"
                  label="State"
                  value={form.state}
                  onChange={(state) => setForm({ ...form, state })}
                />
                <LocationField
                  id="location-postal-code"
                  label="ZIP / postal code"
                  value={form.postalCode}
                  onChange={(postalCode) => setForm({ ...form, postalCode })}
                />
              </div>
              <LocationField
                id="location-country"
                label="Country"
                value={form.country}
                onChange={(country) => setForm({ ...form, country })}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <LocationField
                  id="location-latitude"
                  label="Latitude"
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
                  label="Longitude"
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
                  Cancel
                </Button>
                <Button
                  variant="default"
                  type="submit"
                  disabled={!form.name.trim() || save.isPending}
                >
                  {save.isPending ? "Saving…" : "Save location"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </section>
    </>
  );
}

function LocationField({
  id,
  label,
  value,
  onChange,
  required,
  type = "text",
}: {
  id: string;
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  required?: boolean;
  type?: "text" | "number";
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
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
