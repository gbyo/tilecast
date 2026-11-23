import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { kindRoute } from "./model";

/** The most kinds that show as tabs; more show as a selector. */
const MAX_KIND_TABS = 4;

/**
 * Moves between a plugin's instance kinds. One kind needs no navigator, two
 * to four show as tabs, and five to sixteen as a compact selector, which
 * stays usable at phone width and at 720p. The URL is the only selected
 * state: both forms navigate to the kind's canonical route, so browser back
 * and forward move between kinds.
 */
export function HostedKindNavigator({
  manifest,
  current,
}: {
  manifest: PluginManifestV3;
  current: string;
}) {
  const { t } = useTranslation("plugins");
  const navigate = useNavigate();
  const id = useId();
  const kinds = manifest.instances;
  if (kinds.length <= 1) return null;
  if (kinds.length <= MAX_KIND_TABS) {
    return (
      <Tabs value={current}>
        <TabsList>
          {kinds.map((item) => (
            <TabsTrigger
              key={item.path}
              value={item.path}
              render={<Link to={kindRoute(manifest, item)} />}
            >
              {item.noun.plural}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    );
  }
  return (
    <Field className="w-full gap-1 sm:w-fit">
      <FieldLabel htmlFor={id} className="text-xs font-medium">
        {t("hosted.kindSelectorLabel")}
      </FieldLabel>
      <Select
        items={kinds.map((item) => ({
          value: item.path,
          label: item.noun.plural,
        }))}
        value={current}
        onValueChange={(next) => {
          const target = kinds.find((item) => item.path === next);
          if (target && target.path !== current) {
            void navigate(kindRoute(manifest, target));
          }
        }}
      >
        <SelectTrigger id={id} className="w-full sm:w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {kinds.map((item) => (
            <SelectItem key={item.path} value={item.path}>
              {item.noun.plural}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
