import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScreenAccessMode, ScreenScope } from "../../api/types";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";

export type ScreenAccessDraft = {
  mode: ScreenAccessMode;
  scopes: ScreenScope[];
};

type Place = { id: string; name: string };

/**
 * Screen access as an explicit choice: all screens, or only the selected
 * locations and Display Groups. Selecting nothing in restricted mode reaches
 * no screen; it never means the whole fleet.
 *
 * `allowAll` is false when the signed-in account's own access is
 * restricted, because it cannot grant more than it holds.
 */
export function ScreenAccessFields({
  value,
  onChange,
  locations,
  groups,
  idPrefix,
  allowAll = true,
  disabled,
}: {
  value: ScreenAccessDraft;
  onChange: (next: ScreenAccessDraft) => void;
  locations: readonly Place[];
  groups: readonly Place[];
  idPrefix: string;
  allowAll?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["screens"]);
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLowerCase();
  const showSearch = locations.length + groups.length > 8;
  const matches = (place: Place) =>
    !normalizedSearch || place.name.toLowerCase().includes(normalizedSearch);
  const visibleLocations = locations.filter(matches);
  const visibleGroups = groups.filter(matches);
  const has = (type: ScreenScope["type"], id: string) =>
    value.scopes.some((item) => item.type === type && item.id === id);
  const toggle = (scope: ScreenScope, on: boolean) =>
    onChange({
      mode: "restricted",
      scopes: on
        ? [...value.scopes, scope]
        : value.scopes.filter(
            (item) => !(item.type === scope.type && item.id === scope.id),
          ),
    });

  const placeList = (
    type: ScreenScope["type"],
    places: readonly Place[],
    empty: string,
  ) =>
    !places.length ? (
      <p className="text-sm text-muted-foreground">
        {normalizedSearch ? t("scope.noMatch") : empty}
      </p>
    ) : (
      places.map((place) => {
        const id = `${idPrefix}-${type}-${place.id}`;
        return (
          <Field
            key={place.id}
            data-disabled={disabled}
            orientation="horizontal"
            className="items-center"
          >
            <Checkbox
              id={id}
              disabled={disabled}
              checked={has(type, place.id)}
              onCheckedChange={(checked) =>
                toggle({ type, id: place.id }, checked === true)
              }
            />
            <FieldLabel htmlFor={id}>{place.name}</FieldLabel>
          </Field>
        );
      })
    );

  return (
    <div className="grid gap-4">
      <FieldSet>
        <FieldLegend>{t("scope.modeLegend")}</FieldLegend>
        <RadioGroup
          value={value.mode}
          onValueChange={(mode) =>
            onChange({
              mode: mode as ScreenAccessMode,
              scopes: mode === "all" ? [] : value.scopes,
            })
          }
          className="grid gap-3"
        >
          <Field orientation="horizontal" className="items-start gap-3">
            <RadioGroupItem
              value="all"
              id={`${idPrefix}-mode-all`}
              disabled={disabled || !allowAll}
            />
            <div className="grid gap-1">
              <FieldLabel htmlFor={`${idPrefix}-mode-all`}>
                {t("scope.modeFull")}
              </FieldLabel>
              <p className="text-sm text-muted-foreground">
                {allowAll ? t("scope.modeFullHint") : t("scope.delegationNote")}
              </p>
            </div>
          </Field>
          <Field orientation="horizontal" className="items-start gap-3">
            <RadioGroupItem
              value="restricted"
              id={`${idPrefix}-mode-restricted`}
              disabled={disabled}
            />
            <div className="grid gap-1">
              <FieldLabel htmlFor={`${idPrefix}-mode-restricted`}>
                {t("scope.modeLimited")}
              </FieldLabel>
              <p className="text-sm text-muted-foreground">
                {t("scope.limited", { count: value.scopes.length })}
              </p>
            </div>
          </Field>
        </RadioGroup>
      </FieldSet>

      {value.mode === "restricted" && (
        <>
          <p className="text-sm text-muted-foreground">
            {t("scope.combineNote")}
          </p>
          {showSearch && (
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-search`}>
                {t("scope.searchLabel")}
              </FieldLabel>
              <Input
                id={`${idPrefix}-search`}
                type="search"
                value={search}
                placeholder={t("scope.searchPlaceholder")}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
          )}
          <FieldSet className="grid gap-2">
            <FieldLegend variant="label">{t("scope.locations")}</FieldLegend>
            {placeList("location", visibleLocations, t("scope.noLocations"))}
          </FieldSet>
          <FieldSet className="grid gap-2">
            <FieldLegend variant="label">{t("scope.groups")}</FieldLegend>
            {placeList("group", visibleGroups, t("scope.noGroups"))}
          </FieldSet>
          {value.scopes.length === 0 && (
            <p className="text-sm text-muted-foreground" role="note">
              {t("scope.limitedEmpty")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
