import { LayoutTemplate, ListVideo, Tags } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PlaylistPicker,
  type PlaylistPickerChoice,
} from "../components/content-picker";
import { Button } from "../components/ui/button";
import { Field, FieldError } from "../components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { RadioGroup } from "../components/ui/radio-group";
import { Skeleton } from "../components/ui/skeleton";
import {
  problemMessage,
  withPresentationMode,
  type PresentationChoice,
  type PresentationMode,
} from "./scheduleEditorModel";
import { ChoiceCard, EditorSection } from "./scheduleEditorParts";
import { ScheduleDisplayControlFields } from "./ScheduleDisplayControlFields";
import { presentationMeta } from "./schedulePresentationModel";
import { useSelectedPresentation } from "./useSelectedPresentation";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";

/** What happens when this schedule wins: show content, or drive the display. */
export function SchedulePresentationSection({
  session,
}: {
  session: ScheduleEditorSession;
}) {
  const { t } = useTranslation("schedules");
  const { draft, edit, readOnly } = session;
  return (
    <EditorSection
      id="schedule-presentation"
      title={t("editor.presentation.title")}
      description={t("editor.presentation.description")}
    >
      <RadioGroup
        aria-label={t("editor.presentation.modeLabel")}
        value={draft.presentationMode}
        disabled={readOnly}
        onValueChange={(mode) =>
          edit((current) =>
            withPresentationMode(current, mode as PresentationMode),
          )
        }
      >
        <ChoiceCard
          id="schedule-mode-content"
          value="content"
          title={t("editor.presentation.content")}
          description={t("editor.presentation.contentHint")}
          disabled={readOnly}
        />
        <ChoiceCard
          id="schedule-mode-display"
          value="display_control"
          title={t("editor.presentation.displayControl")}
          description={t("editor.presentation.displayControlHint")}
          disabled={readOnly}
        />
      </RadioGroup>
      {draft.presentationMode === "content" ? (
        <ContentSelection session={session} />
      ) : (
        <ScheduleDisplayControlFields session={session} />
      )}
    </EditorSection>
  );
}

function ContentSelection({ session }: { session: ScheduleEditorSession }) {
  const { t } = useTranslation("schedules");
  const { draft, update, errors, readOnly } = session;
  const content = draft.content;
  const [pickerOpen, setPickerOpen] = useState(false);
  // Remounting the picker on every open starts it on the current choice with
  // a fresh search, since it only reads its selection when it mounts.
  const [pickerEpoch, setPickerEpoch] = useState(0);
  const [picked, setPicked] = useState<PlaylistPickerChoice | null>(null);
  const problem = errors.presentation
    ? problemMessage(errors.presentation, t)
    : null;
  return (
    <div className="grid gap-2">
      {content ? (
        <SelectedPresentation
          content={content}
          picked={picked}
          readOnly={readOnly}
          onChange={() => {
            setPickerEpoch((epoch) => epoch + 1);
            setPickerOpen(true);
          }}
        />
      ) : (
        <Field data-invalid={problem ? true : undefined}>
          <Button
            id="schedule-presentation-choose"
            type="button"
            variant="outline"
            className="justify-start"
            disabled={readOnly}
            aria-invalid={problem ? true : undefined}
            aria-describedby={
              problem ? "schedule-presentation-error" : undefined
            }
            onClick={() => {
              setPickerEpoch((epoch) => epoch + 1);
              setPickerOpen(true);
            }}
          >
            {t("editor.presentation.choose")}
          </Button>
          {problem && (
            <FieldError id="schedule-presentation-error">{problem}</FieldError>
          )}
        </Field>
      )}
      <PlaylistPicker
        key={pickerEpoch}
        open={pickerOpen}
        includeLayouts
        confirmLabel={t("editor.presentation.use")}
        selectedId={content?.id ?? ""}
        onClose={() => setPickerOpen(false)}
        onConfirm={(choice) => {
          setPicked(choice);
          update({
            content:
              choice.kind === "playlist"
                ? {
                    kind: "playlist",
                    id: choice.playlist.id,
                    name: choice.playlist.name,
                  }
                : {
                    kind: "layout",
                    id: choice.layout.id,
                    name: choice.layout.name,
                  },
          });
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

/**
 * The chosen presentation. The saved schedule already names it; a richer
 * preview comes from the picker's choice or one read of that single resource,
 * never from loading the library.
 */
function SelectedPresentation({
  content,
  picked,
  readOnly,
  onChange,
}: {
  content: PresentationChoice;
  picked: PlaylistPickerChoice | null;
  readOnly: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation("schedules");
  const isPlaylist = content.kind === "playlist";
  const {
    playlist: playlistData,
    layout: layoutData,
    pending,
  } = useSelectedPresentation(content, picked);
  const thumbnail =
    playlistData?.previewItems?.[0]?.thumbnailUrl ??
    playlistData?.items?.[0]?.thumbnailUrl;
  const Icon = isPlaylist
    ? playlistData?.sourceType === "tag"
      ? Tags
      : ListVideo
    : LayoutTemplate;
  return (
    <Item variant="outline">
      <ItemMedia variant="image" className="bg-muted" aria-hidden="true">
        {thumbnail ? (
          <img src={thumbnail} alt="" />
        ) : (
          <Icon className="size-5 text-muted-foreground" />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{content.name}</ItemTitle>
        {pending ? (
          <Skeleton className="h-4 w-40" />
        ) : (
          <ItemDescription>
            {presentationMeta(content.kind, playlistData, layoutData, t)}
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <Button
          id="schedule-presentation-choose"
          type="button"
          variant="outline"
          size="sm"
          disabled={readOnly}
          onClick={onChange}
        >
          {t("editor.presentation.change")}
        </Button>
      </ItemActions>
    </Item>
  );
}
