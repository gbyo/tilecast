import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Location, LocationInput } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Button, Dialog } from "../components/ui";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";

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
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
  const client = useQueryClient();
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
    <section className="locations-settings">
      <div className="locations-settings__toolbar">
        <label className="location-search">
          <Search size={16} />
          <span className="visually-hidden">Search locations</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or address"
          />
        </label>
        {canManage && (
          <Button variant="primary" onClick={() => open("new")}>
            <Plus size={16} /> Add location
          </Button>
        )}
      </div>
      {notice && <div className="notice notice--info">{notice}</div>}
      {query.isError && (
        <div className="notice notice--error" role="alert">
          Location data failed to load. {query.error.message}
        </div>
      )}
      {query.isLoading ? (
        <div className="table-loading">Loading locations…</div>
      ) : (
        <div className="location-list">
          {matches.map((location) => (
            <article className="location-list__row" key={location.id}>
              <span className="location-list__icon">
                <MapPin size={17} />
              </span>
              <span>
                <strong>{location.name}</strong>
                <small>
                  {formatLocationAddress(location) || "No address set"}
                </small>
              </span>
              <span className="location-list__count">
                {location.screenCount} screen
                {location.screenCount === 1 ? "" : "s"}
              </span>
              {canManage && (
                <span className="location-list__actions">
                  <button
                    type="button"
                    aria-label={`Edit ${location.name}`}
                    onClick={() => open(location)}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${location.name}`}
                    disabled={remove.isPending}
                    onClick={async () => {
                      if (location.screenCount > 0) {
                        await confirm({
                          title: "Location cannot be deleted yet",
                          description: `${location.name} still has ${location.screenCount} screens assigned. Reassign or unassign them first.`,
                          confirmLabel: "Got it",
                        });
                        return;
                      }
                      if (await confirm({
                        title: `Delete ${location.name}?`,
                        description:
                          "This location will be removed from the installation.",
                        confirmLabel: "Delete location",
                        tone: "negative",
                      })) {
                        remove.mutate(location);
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </span>
              )}
            </article>
          ))}
          {!matches.length && (
            <div className="screen-empty screen-empty--compact">
              <MapPin size={24} />
              <h3>{search ? "No locations match" : "No locations yet"}</h3>
              <p>
                {search
                  ? "Try a different name or address."
                  : "Add a building or campus to assign it to screens."}
              </p>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={Boolean(editing)}
        title={editing === "new" ? "Add location" : "Edit location"}
        onClose={() => setEditing(undefined)}
      >
        <form
          className="location-form"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <LocationField
            label="Location name"
            required
            value={form.name}
            onChange={(name) => setForm({ ...form, name })}
          />
          <LocationField
            label="Address line 1"
            value={form.addressLine1}
            onChange={(addressLine1) => setForm({ ...form, addressLine1 })}
          />
          <LocationField
            label="Address line 2"
            value={form.addressLine2}
            onChange={(addressLine2) => setForm({ ...form, addressLine2 })}
          />
          <div className="location-form__row">
            <LocationField
              label="City"
              value={form.city}
              onChange={(city) => setForm({ ...form, city })}
            />
            <LocationField
              label="State"
              value={form.state}
              onChange={(state) => setForm({ ...form, state })}
            />
            <LocationField
              label="ZIP / postal code"
              value={form.postalCode}
              onChange={(postalCode) => setForm({ ...form, postalCode })}
            />
          </div>
          <LocationField
            label="Country"
            value={form.country}
            onChange={(country) => setForm({ ...form, country })}
          />
          <div className="location-form__row">
            <LocationField
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
            <div className="notice notice--error">{save.error.message}</div>
          )}
          <footer className="dialog-actions">
            <Button
              variant="quiet"
              type="button"
              onClick={() => setEditing(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={!form.name.trim() || save.isPending}
            >
              {save.isPending ? "Saving…" : "Save location"}
            </Button>
          </footer>
        </form>
      </Dialog>
    </section>
  );
}

function LocationField({
  label,
  value,
  onChange,
  required,
  type = "text",
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  required?: boolean;
  type?: "text" | "number";
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        step={type === "number" ? "any" : undefined}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
