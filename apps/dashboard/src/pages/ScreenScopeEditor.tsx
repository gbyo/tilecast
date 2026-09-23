import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ScreenScope } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";

// No selection means the whole fleet. That is stated rather than implied,
// because an empty list of grants reads equally well as "nothing", and getting
// it backwards would look like a lockout.
export function ScreenScopeEditor({
  userId,
  userRole,
  csrf,
  disabled,
}: {
  userId: string;
  userRole: string;
  csrf: string;
  disabled?: boolean;
}) {
  const scopes = useQuery({
    queryKey: ["screen-scopes", userId],
    queryFn: () => api.userScreenScopes(userId),
    enabled: userRole !== "owner",
  });
  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: api.locations,
    enabled: userRole !== "owner",
  });
  const groups = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
    enabled: userRole !== "owner",
  });

  const [selected, setSelected] = useState<ScreenScope[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    // A response without the array must not take the dialog down with it: this
    // editor is embedded in the account editor, which has its own work to do.
    if (scopes.data) setSelected(scopes.data.scopes ?? []);
  }, [scopes.data]);

  const save = useMutation({
    mutationFn: () => api.putUserScreenScopes(userId, selected, csrf),
    onSuccess: () => {
      setSaved(true);
      void scopes.refetch();
    },
  });

  if (userRole === "owner")
    return (
      <p className="role-description">
        Owner access applies to the entire fleet.
      </p>
    );

  const toggle = (scope: ScreenScope, on: boolean) => {
    setSaved(false);
    setSelected((current) =>
      on
        ? [...current, scope]
        : current.filter(
            (item) => !(item.type === scope.type && item.id === scope.id),
          ),
    );
  };
  const has = (type: string, id: string) =>
    selected.some((item) => item.type === type && item.id === id);

  return (
    <div className="screen-scope-editor">
      <p className="role-description">
        {selected.length === 0
          ? "This account can operate every screen. Select buildings or Display Groups to narrow it."
          : `This account can operate screens in ${selected.length} selected ${selected.length === 1 ? "place" : "places"} only. It still sees the whole content library.`}
      </p>

      {scopes.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading scope…</p>
      ) : (
        <>
          <FieldSet className="grid gap-2">
            <FieldLegend variant="label">Locations</FieldLegend>
            {!locations.data?.items?.length ? (
              <p className="text-sm text-muted-foreground">
                No locations exist.
              </p>
            ) : (
              locations.data.items.map((location) => {
                const id = `screen-scope-location-${location.id}`;
                return (
                  <Field
                    key={location.id}
                    data-disabled={disabled}
                    orientation="horizontal"
                    className="items-center"
                  >
                    <Checkbox
                      id={id}
                      disabled={disabled}
                      checked={has("location", location.id)}
                      onCheckedChange={(checked) =>
                        toggle(
                          { type: "location", id: location.id },
                          checked === true,
                        )
                      }
                    />
                    <FieldLabel htmlFor={id}>{location.name}</FieldLabel>
                  </Field>
                );
              })
            )}
          </FieldSet>

          <FieldSet className="grid gap-2">
            <FieldLegend variant="label">Display Groups</FieldLegend>
            {!groups.data?.items?.length ? (
              <p className="text-sm text-muted-foreground">
                No Display Groups exist.
              </p>
            ) : (
              groups.data.items.map((group) => {
                const id = `screen-scope-group-${group.id}`;
                return (
                  <Field
                    key={group.id}
                    data-disabled={disabled}
                    orientation="horizontal"
                    className="items-center"
                  >
                    <Checkbox
                      id={id}
                      disabled={disabled}
                      checked={has("group", group.id)}
                      onCheckedChange={(checked) =>
                        toggle(
                          { type: "group", id: group.id },
                          checked === true,
                        )
                      }
                    />
                    <FieldLabel htmlFor={id}>{group.name}</FieldLabel>
                  </Field>
                );
              })
            )}
          </FieldSet>

          <div className="settings-subsection__action">
            <div>{saved && <span>Screen scope saved.</span>}</div>
            <Button
              type="button"
              disabled={disabled || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save screen scope"}
            </Button>
          </div>
          {save.error && (
            <Alert variant="destructive">
              <AlertDescription>{save.error.message}</AlertDescription>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
