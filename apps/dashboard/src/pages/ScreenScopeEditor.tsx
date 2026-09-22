import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@react-spectrum/s2/Button";
import { Checkbox } from "@react-spectrum/s2/Checkbox";
import { Heading } from "@react-spectrum/s2/Heading";
import { InlineAlert } from "@react-spectrum/s2/InlineAlert";
import { ProgressBar } from "@react-spectrum/s2/ProgressBar";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { Text } from "@react-spectrum/s2/Text";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { api } from "../api/client";
import type { ScreenScope } from "../api/types";

const editorStyles = style({ display: "flex", flexDirection: "column", gap: 16 });
const checkListStyles = style({ display: "grid", gap: 8 });

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
      <Text>
        Owner access applies to the entire fleet.
      </Text>
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
    <div className={editorStyles}>
      <Text>
        {selected.length === 0
          ? "This account can operate every screen. Select buildings or Display Groups to narrow it."
          : `This account can operate screens in ${selected.length} selected ${selected.length === 1 ? "place" : "places"} only. It still sees the whole content library.`}
      </Text>

      {scopes.isLoading || locations.isLoading || groups.isLoading ? (
        <ProgressBar label="Loading screen scope" isIndeterminate />
      ) : (
        <>
          {(scopes.error || locations.error || groups.error) && (
            <InlineAlert variant="negative" fillStyle="subtleFill">
              <Heading level={3}>Screen scope could not be loaded</Heading>
              <Text>
                {(scopes.error ?? locations.error ?? groups.error)?.message ??
                  "Please try again."}
              </Text>
            </InlineAlert>
          )}
          <section aria-labelledby="scope-locations-heading">
            <Heading id="scope-locations-heading" level={4}>Locations</Heading>
            {!locations.data?.items?.length ? (
              <Text>No locations exist.</Text>
            ) : (
              <div className={checkListStyles}>
                {locations.data.items.map((location) => (
                  <Checkbox
                    key={location.id}
                    isDisabled={disabled}
                    isSelected={has("location", location.id)}
                    onChange={(on) =>
                      toggle({ type: "location", id: location.id }, on)
                    }
                  >
                    {location.name}
                  </Checkbox>
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="scope-groups-heading">
            <Heading id="scope-groups-heading" level={4}>Display Groups</Heading>
            {!groups.data?.items?.length ? (
              <Text>No Display Groups exist.</Text>
            ) : (
              <div className={checkListStyles}>
                {groups.data.items.map((group) => (
                  <Checkbox
                    key={group.id}
                    isDisabled={disabled}
                    isSelected={has("group", group.id)}
                    onChange={(on) => toggle({ type: "group", id: group.id }, on)}
                  >
                    {group.name}
                  </Checkbox>
                ))}
              </div>
            )}
          </section>

          <div>
            {saved && <StatusLight variant="positive">Screen scope saved</StatusLight>}
            <Button
              variant="accent"
              isDisabled={disabled || save.isPending}
              isPending={save.isPending}
              onPress={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save screen scope"}
            </Button>
          </div>
          {save.error && (
            <InlineAlert variant="negative" fillStyle="subtleFill">
              <Heading level={3}>Screen scope could not be saved</Heading>
              <Text>{save.error.message}</Text>
            </InlineAlert>
          )}
        </>
      )}
    </div>
  );
}
