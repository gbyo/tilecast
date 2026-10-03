import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { PairingRequest, Screen } from "../api/types";
import { screenQueries } from "../data/screens";
import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../components/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { deviceLabel } from "./pairingFlow";

export type PairingOperation =
  | "new_screen"
  | "credential_repair"
  | "replace_hardware";

/**
 * Decides what pairing means, with progressive disclosure. A recognized
 * player reconnects: the server permits no other outcome for an installation
 * with an active credential. A fresh player creates a screen, with hardware
 * replacement one quiet step away.
 */
export function PairingDestination({
  request,
  destination,
  onChange,
  replacementScreenId,
  onReplacementScreenChange,
}: {
  request: PairingRequest;
  destination: PairingOperation;
  onChange: (destination: PairingOperation) => void;
  replacementScreenId: string;
  onReplacementScreenChange: (screenId: string) => void;
}) {
  const { t } = useTranslation("screens");
  const { t: commonT } = useTranslation("common");
  const recognized =
    request.previouslyPaired && request.hasActiveCredential;
  const screens = useQuery({
    ...screenQueries.replacementOptions(),
    enabled: destination === "replace_hardware",
  });

  if (recognized) {
    const name = request.existingScreenName ?? deviceLabel(request);
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-medium">
          {t("destination.reconnectTo", { name })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("destination.reconnectBody", { name })}
        </p>
      </div>
    );
  }

  if (destination === "replace_hardware") {
    const eligibleScreens = (screens.data?.items ?? []).filter(
      (screen) => screen.id !== request.existingScreenId,
    );
    const selected = eligibleScreens.find(
      (screen) => screen.id === replacementScreenId,
    );
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t("destination.replaceBody")}
        </p>
        <Field>
          <FieldLabel htmlFor="pairing-existing-screen">
            {t("approval.existingScreen")}
          </FieldLabel>
          <Combobox
            items={eligibleScreens}
            value={selected ?? null}
            itemToStringLabel={(screen: Screen) =>
              screen.location
                ? screen.name + " — " + screen.location
                : screen.name
            }
            onValueChange={(value) =>
              onReplacementScreenChange(value?.id ?? "")
            }
          >
            <ComboboxInput
              id="pairing-existing-screen"
              aria-label={t("approval.existingScreen")}
              placeholder={t("approval.searchScreens")}
              showClear
              className="w-full"
            />
            <ComboboxContent>
              <ComboboxEmpty>
                {screens.isLoading
                  ? commonT("status.loading")
                  : screens.isError
                    ? t("approval.screensLoadError")
                    : t("approval.noMatchingScreens")}
              </ComboboxEmpty>
              <ComboboxList>
                {(screen: Screen) => (
                  <ComboboxItem key={screen.id} value={screen}>
                    {screen.name}
                    {screen.location ? ` — ${screen.location}` : ""}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <FieldDescription>{t("approval.selectHint")}</FieldDescription>
        </Field>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          onClick={() => onChange("new_screen")}
        >
          {t("destination.showNew")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{t("approval.newScreen")}</p>
      <p className="text-sm text-muted-foreground">
        {t("approval.newScreenHint")}
      </p>
      <Button
        type="button"
        variant="link"
        className="h-auto p-0"
        onClick={() => onChange("replace_hardware")}
      >
        {t("destination.showReplace")}
      </Button>
    </div>
  );
}
