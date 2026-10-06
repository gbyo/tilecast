/**
 * The Widget's settings, grouped by the sections its definition declares.
 * One section shows directly; two or more become Tabs. Empty sections never
 * appear, and rare settings sit under Advanced at the end of their section.
 */
import {
  authoringUiOf,
  groupAuthoringFields,
  visibleAuthoringFields,
  type WidgetAuthoringSection,
} from "@tilecast/widget-sdk";
import { CircleAlert, SlidersHorizontal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ContentDefinitionField } from "@/api/types";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/studio/StudioCollapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WidgetInspectorField } from "./fields/WidgetInspectorField";
import { fieldDomId, type InspectorFieldProps } from "./fields/fieldContext";
import { RowIdentityEpoch } from "./fields/rowIdentity";
import type {
  WidgetEditorSession,
  WidgetFocusRequest,
} from "./useWidgetEditorSession";

const FOCUSABLE =
  'input:not([type="hidden"]):not(:disabled), button:not(:disabled), textarea:not(:disabled), [role="combobox"], [role="radio"], [tabindex]:not([tabindex="-1"])';

function focusField(path: string) {
  const element = document.getElementById(fieldDomId(path));
  if (!element) return;
  const target = element.matches(FOCUSABLE)
    ? element
    : element.querySelector<HTMLElement>(FOCUSABLE);
  if (typeof target?.scrollIntoView === "function")
    target.scrollIntoView({ block: "center" });
  target?.focus({ preventScroll: true });
}

export function WidgetInspector(props: {
  session: WidgetEditorSession;
  csrf: string;
}) {
  // Discarding replaces the draft wholesale, so list rows start over.
  return (
    <RowIdentityEpoch value={props.session.draftEpoch}>
      <InspectorSections {...props} />
    </RowIdentityEpoch>
  );
}

function InspectorSections({
  session,
  csrf,
}: {
  session: WidgetEditorSession;
  csrf: string;
}) {
  const { t } = useTranslation("content");
  const fields = session.definition.configurationSchema.fields;
  const configuration = session.draft.configuration;
  const groups = groupAuthoringFields(
    visibleAuthoringFields(fields, configuration),
  );
  const sections = groups.map((group) => group.section);
  const [chosen, setChosen] = useState<WidgetAuthoringSection | null>(null);
  // A section can disappear when a setting hides its last field.
  const active =
    chosen && sections.includes(chosen) ? chosen : (sections[0] ?? null);
  const request = session.focusRequest;
  const focusPath = request?.target === "field" ? (request.path ?? null) : null;
  const focusNonce = request?.target === "field" ? request.nonce : 0;

  // A request to show a problem selects the tab that holds it. This is
  // state derived from a changing prop, so it is adjusted while rendering
  // rather than corrected after a paint of the wrong tab.
  const [handledRequest, setHandledRequest] =
    useState<WidgetFocusRequest | null>(null);
  if (request !== handledRequest) {
    setHandledRequest(request);
    if (request?.target === "field" && request.section)
      setChosen(request.section);
  }

  useEffect(() => {
    if (request?.target !== "field" || !request.path) return;
    // Wait for the tab, Advanced group, or Accordion item to open.
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => focusField(request.path!)),
    );
    return () => cancelAnimationFrame(frame);
  }, [request]);

  const errorFor = (path: string) =>
    session.revealed ? session.validation.byPath.get(path) : undefined;
  const sectionHasIssue = (section: WidgetAuthoringSection) =>
    session.revealed &&
    session.validation.issues.some((issue) => issue.section === section);

  const fieldProps = (field: ContentDefinitionField): InspectorFieldProps => ({
    field,
    path: field.key,
    value: configuration[field.key],
    values: configuration,
    fields,
    rootValues: configuration,
    rootFields: fields,
    onChange: (next) => session.updateField(field.key, next),
    readOnly: session.readOnly,
    csrf,
    errorFor,
    focusPath,
    focusNonce,
  });
  const sectionLabel = (section: WidgetAuthoringSection) =>
    t(`widgets.editor.sections.${section}`);

  if (groups.length === 0)
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SlidersHorizontal aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{t("widgets.editor.noSettingsTitle")}</EmptyTitle>
          <EmptyDescription>{t("widgets.editor.noSettings")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const body = (list: ContentDefinitionField[]) => (
    <SectionFields
      fields={list}
      fieldProps={fieldProps}
      advancedOpenFor={(advanced) =>
        Boolean(
          focusPath &&
          advanced.some(
            (field) =>
              focusPath === field.key || focusPath.startsWith(`${field.key}.`),
          ),
        )
      }
    />
  );

  if (groups.length === 1) {
    const only = groups[0]!;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <h2 className="shrink-0 border-b border-border px-4 py-3 text-sm font-semibold">
          {sectionLabel(only.section)}
        </h2>
        <ScrollArea className="min-h-0 flex-1">{body(only.fields)}</ScrollArea>
      </div>
    );
  }

  return (
    <Tabs
      value={active}
      onValueChange={(next) => setChosen(next as WidgetAuthoringSection)}
      className="h-full min-h-0 gap-0"
    >
      <div className="shrink-0 border-b border-border px-3 pt-2">
        <TabsList
          variant="line"
          aria-label={t("widgets.editor.sectionsLabel")}
          className="w-full justify-start overflow-x-auto"
        >
          {groups.map((group) => (
            <TabsTrigger
              key={group.section}
              value={group.section}
              className="flex-none"
            >
              {sectionLabel(group.section)}
              {sectionHasIssue(group.section) && (
                <>
                  <CircleAlert
                    aria-hidden="true"
                    className="text-destructive"
                  />
                  <span className="sr-only">
                    {t("widgets.editor.sectionHasIssues")}
                  </span>
                </>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {groups.map((group) => (
        <TabsContent
          key={group.section}
          value={group.section}
          className="min-h-0 flex-1"
        >
          <ScrollArea className="h-full">{body(group.fields)}</ScrollArea>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function SectionFields({
  fields,
  fieldProps,
  advancedOpenFor,
}: {
  fields: ContentDefinitionField[];
  fieldProps: (field: ContentDefinitionField) => InspectorFieldProps;
  advancedOpenFor: (advanced: ContentDefinitionField[]) => boolean;
}) {
  const primary = fields.filter((field) => !authoringUiOf(field).advanced);
  const advanced = fields.filter((field) => authoringUiOf(field).advanced);
  return (
    <div className="grid gap-6 p-4">
      {primary.map((field) => (
        <WidgetInspectorField key={field.key} {...fieldProps(field)} />
      ))}
      {advanced.length > 0 && (
        <AdvancedFields forceOpen={advancedOpenFor(advanced)}>
          {advanced.map((field) => (
            <WidgetInspectorField key={field.key} {...fieldProps(field)} />
          ))}
        </AdvancedFields>
      )}
    </div>
  );
}

function AdvancedFields({
  forceOpen,
  children,
}: {
  forceOpen: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation("content");
  const [open, setOpen] = useState(forceOpen);
  // A problem inside the group opens it. Adjusted while rendering, since
  // it is state derived from a prop.
  const [wasForced, setWasForced] = useState(forceOpen);
  if (forceOpen !== wasForced) {
    setWasForced(forceOpen);
    if (forceOpen) setOpen(true);
  }
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-t border-border pt-4"
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("widgets.editor.advanced")}
        <CollapsibleChevron size={16} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-6 pt-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
