import { Save, Tag, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ContentTag } from "../../api/types";
import { Alert, AlertDescription } from "../ui/alert";
import { Button as RheaButton } from "../ui/button";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../ui/drawer";
import { Textarea } from "../ui/textarea";

const sourceTypeOptions: {
  value: "static" | "tag";
  labelKey: "details.sourceOptions.manual" | "details.sourceOptions.fromTags";
}[] = [
  { value: "static", labelKey: "details.sourceOptions.manual" },
  { value: "tag", labelKey: "details.sourceOptions.fromTags" },
];

const tagMatchOptions: {
  value: "any" | "all";
  labelKey: "details.matchOptions.any" | "details.matchOptions.all";
}[] = [
  { value: "any", labelKey: "details.matchOptions.any" },
  { value: "all", labelKey: "details.matchOptions.all" },
];

export function PlaylistDetailsDrawer({
  open,
  canManage,
  sourceType,
  name,
  description,
  tagMatch,
  tagIds,
  tagImageSeconds,
  tags,
  metadataDirty,
  tagRuleDirty,
  metadataSaving,
  tagRuleSaving,
  metadataError,
  tagRuleError,
  onClose,
  onNameChange,
  onDescriptionChange,
  onSourceTypeChange,
  onTagMatchChange,
  onTagToggle,
  onTagImageSecondsChange,
  onSaveMetadata,
  onSaveTagRule,
}: {
  open: boolean;
  canManage: boolean;
  sourceType: "static" | "tag";
  name: string;
  description: string;
  tagMatch: "any" | "all";
  tagIds: string[];
  tagImageSeconds: number;
  tags: ContentTag[];
  metadataDirty: boolean;
  tagRuleDirty: boolean;
  metadataSaving: boolean;
  tagRuleSaving: boolean;
  metadataError?: string;
  tagRuleError?: string;
  onClose: () => void;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSourceTypeChange: (value: "static" | "tag") => void;
  onTagMatchChange: (value: "any" | "all") => void;
  onTagToggle: (tagId: string) => void;
  onTagImageSecondsChange: (value: number) => void;
  onSaveMetadata: () => void;
  onSaveTagRule: () => void;
}) {
  const { t } = useTranslation(["playlists", "common"]);
  return (
    <Drawer
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      showSwipeHandle
    >
      <DrawerContent className="max-h-[calc(100dvh-2rem)]">
        <DrawerHeader className="relative">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {sourceType === "tag"
              ? t("details.kindTag")
              : t("details.kindSettings")}
          </p>
          <DrawerTitle>{t("details.title")}</DrawerTitle>
          <DrawerDescription>{t("details.description")}</DrawerDescription>
          <RheaButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-3"
            aria-label="Close playlist details"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </RheaButton>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <section className="grid gap-3">
            <h3 className="text-sm font-medium">
              {t("details.sectionDetails")}
            </h3>
            <Field>
              <FieldLabel htmlFor="playlist-details-name">
                {t("details.nameLabel")}
              </FieldLabel>
              <Input
                id="playlist-details-name"
                disabled={!canManage}
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="playlist-details-description">
                {t("details.descriptionLabel")}
              </FieldLabel>
              <Textarea
                id="playlist-details-description"
                disabled={!canManage}
                value={description}
                onChange={(event) => onDescriptionChange(event.target.value)}
              />
            </Field>
            {metadataError && (
              <Alert variant="destructive">
                <AlertDescription>{metadataError}</AlertDescription>
              </Alert>
            )}
            <div>
              <RheaButton
                type="button"
                size="sm"
                disabled={!canManage || !metadataDirty || metadataSaving}
                onClick={onSaveMetadata}
              >
                <Save size={14} aria-hidden="true" />
                {metadataSaving
                  ? t("common:actions.saving")
                  : t("details.saveDetails")}
              </RheaButton>
            </div>
          </section>

          <section className="grid gap-3">
            <h3 className="text-sm font-medium">{t("details.sourceTitle")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("details.sourceDescription")}
            </p>
            <Field>
              <FieldLabel htmlFor="playlist-details-source">
                {t("details.sourceLabel")}
              </FieldLabel>
              <RheaSelect
                disabled={!canManage}
                value={sourceType}
                onValueChange={(next) =>
                  onSourceTypeChange(next as "static" | "tag")
                }
                items={sourceTypeOptions.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
              >
                <SelectTrigger
                  id="playlist-details-source"
                  aria-label={t("details.sourceLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceTypeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>

            {sourceType === "tag" && (
              <>
                <Field>
                  <FieldLabel htmlFor="playlist-details-match">
                    {t("details.matchLabel")}
                  </FieldLabel>
                  <RheaSelect
                    disabled={!canManage}
                    value={tagMatch}
                    onValueChange={(next) =>
                      onTagMatchChange(next as "any" | "all")
                    }
                    items={tagMatchOptions.map((option) => ({
                      value: option.value,
                      label: t(option.labelKey),
                    }))}
                  >
                    <SelectTrigger
                      id="playlist-details-match"
                      aria-label={t("details.matchLabel")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {tagMatchOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </RheaSelect>
                </Field>
                <Field>
                  <span className="text-sm font-medium">
                    {t("details.tagsLabel")}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {tags.length ? (
                      tags.map((tag) => {
                        const active = tagIds.includes(tag.id);
                        return (
                          <RheaButton
                            key={tag.id}
                            type="button"
                            variant={active ? "default" : "outline"}
                            size="sm"
                            aria-pressed={active}
                            disabled={!canManage}
                            onClick={() => onTagToggle(tag.id)}
                          >
                            <span
                              className="size-2 rounded-full"
                              style={{ backgroundColor: tag.color }}
                              aria-hidden="true"
                            />
                            {tag.name}
                          </RheaButton>
                        );
                      })
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {t("details.noTags")}
                      </span>
                    )}
                  </div>
                </Field>
                <Field>
                  <FieldLabel htmlFor="playlist-details-image-duration">
                    {t("details.imageDurationLabel")}
                  </FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      id="playlist-details-image-duration"
                      className="w-28"
                      type="number"
                      min="1"
                      max="86400"
                      disabled={!canManage}
                      value={tagImageSeconds}
                      onChange={(event) =>
                        onTagImageSecondsChange(Number(event.target.value))
                      }
                    />
                    <span className="text-sm text-muted-foreground">
                      {t("details.secondsUnit")}
                    </span>
                  </div>
                  <FieldDescription>
                    {t("details.imageDurationHint")}
                  </FieldDescription>
                </Field>
                {tagIds.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {t("details.tagRequired")}
                  </p>
                )}
              </>
            )}
            {tagRuleError && (
              <Alert variant="destructive">
                <AlertDescription>{tagRuleError}</AlertDescription>
              </Alert>
            )}
            <div>
              <RheaButton
                type="button"
                size="sm"
                disabled={
                  !canManage ||
                  !tagRuleDirty ||
                  tagRuleSaving ||
                  (sourceType === "tag" && tagIds.length === 0)
                }
                onClick={onSaveTagRule}
              >
                <Tag size={14} aria-hidden="true" />
                {tagRuleSaving
                  ? t("common:actions.saving")
                  : t("details.saveSource")}
              </RheaButton>
            </div>
          </section>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
