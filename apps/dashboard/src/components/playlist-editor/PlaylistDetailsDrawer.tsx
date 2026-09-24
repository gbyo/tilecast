import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ContentTag } from "../../api/types";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../ui/field";
import { Input } from "../ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "../ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "../ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import { Toggle } from "../ui/toggle";

export type PlaylistDetailsTab = "general" | "source" | "usage";

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
  desktop,
  open,
  tab,
  canManage,
  sourceType,
  name,
  description,
  tagMatch,
  tagIds,
  tagImageSeconds,
  tags,
  usage,
  metadataDirty,
  tagRuleDirty,
  metadataSaving,
  tagRuleSaving,
  metadataError,
  tagRuleError,
  onTabChange,
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
  desktop: boolean;
  open: boolean;
  tab: PlaylistDetailsTab;
  canManage: boolean;
  sourceType: "static" | "tag";
  name: string;
  description: string;
  tagMatch: "any" | "all";
  tagIds: string[];
  tagImageSeconds: number;
  tags: ContentTag[];
  /** The Used By composition shown under the Usage tab. */
  usage: ReactNode;
  metadataDirty: boolean;
  tagRuleDirty: boolean;
  metadataSaving: boolean;
  tagRuleSaving: boolean;
  metadataError?: string;
  tagRuleError?: string;
  onTabChange: (tab: PlaylistDetailsTab) => void;
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
  const { t } = useTranslation("playlists");
  const sourceTypeItems = sourceTypeOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const tagMatchItems = tagMatchOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const body = (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as PlaylistDetailsTab)}
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList variant="line" className="mx-4 shrink-0">
        <TabsTrigger value="general">{t("details.tabs.general")}</TabsTrigger>
        <TabsTrigger value="source">{t("details.tabs.source")}</TabsTrigger>
        <TabsTrigger value="usage">{t("details.tabs.usage")}</TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto border-t px-4 pt-5 pb-4">
        <TabsContent value="general">
          <FieldGroup>
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
              <FieldDescription>
                {t("details.descriptionHint")}
              </FieldDescription>
            </Field>
            {metadataError && (
              <Alert variant="destructive">
                <AlertDescription>{metadataError}</AlertDescription>
              </Alert>
            )}
            <div>
              <Button
                type="button"
                disabled={!canManage || !metadataDirty || metadataSaving}
                onClick={onSaveMetadata}
              >
                {metadataSaving && <Spinner aria-hidden="true" />}
                {t("details.saveDetails")}
              </Button>
            </div>
          </FieldGroup>
        </TabsContent>

        <TabsContent value="source">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="playlist-details-source">
                {t("details.sourceLabel")}
              </FieldLabel>
              <Select
                disabled={!canManage}
                value={sourceType}
                onValueChange={(next) =>
                  onSourceTypeChange(next as "static" | "tag")
                }
                items={sourceTypeItems}
              >
                <SelectTrigger
                  id="playlist-details-source"
                  aria-label={t("details.sourceLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceTypeItems.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t("details.sourceHint")}</FieldDescription>
            </Field>

            {sourceType === "tag" && (
              <>
                <Field>
                  <FieldLabel htmlFor="playlist-details-match">
                    {t("details.matchLabel")}
                  </FieldLabel>
                  <Select
                    disabled={!canManage}
                    value={tagMatch}
                    onValueChange={(next) =>
                      onTagMatchChange(next as "any" | "all")
                    }
                    items={tagMatchItems}
                  >
                    <SelectTrigger
                      id="playlist-details-match"
                      aria-label={t("details.matchLabel")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {tagMatchItems.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <FieldSet>
                  <FieldLegend variant="label">
                    {t("details.tagsLabel")}
                  </FieldLegend>
                  <div className="flex flex-wrap gap-2">
                    {tags.length ? (
                      tags.map((tag) => (
                        <Toggle
                          key={tag.id}
                          variant="outline"
                          size="sm"
                          pressed={tagIds.includes(tag.id)}
                          disabled={!canManage}
                          onPressedChange={() => onTagToggle(tag.id)}
                        >
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: tag.color }}
                            aria-hidden="true"
                          />
                          {tag.name}
                        </Toggle>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {t("details.noTags")}
                      </span>
                    )}
                  </div>
                  {tagIds.length === 0 && (
                    <FieldDescription>
                      {t("details.tagRequired")}
                    </FieldDescription>
                  )}
                </FieldSet>
                <Field>
                  <FieldLabel htmlFor="playlist-details-image-duration">
                    {t("details.imageDurationLabel")}
                  </FieldLabel>
                  <InputGroup className="w-32">
                    <InputGroupInput
                      id="playlist-details-image-duration"
                      type="number"
                      min="1"
                      max="86400"
                      disabled={!canManage}
                      value={tagImageSeconds}
                      onChange={(event) =>
                        onTagImageSecondsChange(Number(event.target.value))
                      }
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupText>
                        {t("details.secondsUnit")}
                      </InputGroupText>
                    </InputGroupAddon>
                  </InputGroup>
                  <FieldDescription>
                    {t("details.imageDurationHint")}
                  </FieldDescription>
                </Field>
              </>
            )}
            {tagRuleError && (
              <Alert variant="destructive">
                <AlertDescription>{tagRuleError}</AlertDescription>
              </Alert>
            )}
            <div>
              <Button
                type="button"
                disabled={
                  !canManage ||
                  !tagRuleDirty ||
                  tagRuleSaving ||
                  (sourceType === "tag" && tagIds.length === 0)
                }
                onClick={onSaveTagRule}
              >
                {tagRuleSaving && <Spinner aria-hidden="true" />}
                {t("details.saveSource")}
              </Button>
            </div>
          </FieldGroup>
        </TabsContent>

        <TabsContent value="usage">{usage}</TabsContent>
      </div>
    </Tabs>
  );

  if (desktop) {
    return (
      <Sheet
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
      >
        <SheetContent side="right" className="gap-0 overflow-hidden">
          <SheetHeader>
            <SheetTitle>{t("details.title")}</SheetTitle>
            <SheetDescription>
              {t("details.drawerDescription")}
            </SheetDescription>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      showSwipeHandle
    >
      <DrawerContent className="max-h-[calc(100dvh-2rem)]">
        <DrawerHeader>
          <DrawerTitle>{t("details.title")}</DrawerTitle>
          <DrawerDescription>
            {t("details.drawerDescription")}
          </DrawerDescription>
        </DrawerHeader>
        {body}
        <DrawerFooter className="border-t">
          <DrawerClose render={<Button type="button" variant="outline" />}>
            {t("details.done")}
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
