import { useQuery } from "@tanstack/react-query";
import { LayoutTemplate, ListVideo, Tags } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DisplayControlAction,
  LayoutSummary,
  Playlist,
} from "../api/types";
import {
  PlaylistPicker,
  type PlaylistPickerChoice,
} from "../components/content-picker";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { RadioGroup } from "../components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { layoutQueries } from "../data/layouts";
import { playlistQueries } from "../data/playlists";
import { displayActionOptions, type SchedulesT } from "./scheduleBuilderModel";
import {
  DISPLAY_INPUT_MAX,
  problemMessage,
  withPresentationMode,
  type PresentationChoice,
  type PresentationMode,
} from "./scheduleEditorModel";
import { ChoiceCard, EditorSection } from "./scheduleEditorParts";
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
        <DisplayControlFields session={session} />
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
  // The picker's rows are list summaries: enough to show the choice now, but a
  // playlist's length needs its own items, so that one playlist is read.
  const pickedPlaylist =
    picked?.kind === "playlist" && picked.playlist.id === content.id
      ? picked.playlist
      : undefined;
  const pickedLayout =
    picked?.kind === "layout" && picked.layout.id === content.id
      ? picked.layout
      : undefined;
  const playlist = useQuery({
    ...playlistQueries.detail(content.id),
    enabled: isPlaylist,
    placeholderData: pickedPlaylist,
  });
  const layout = useQuery({
    ...layoutQueries.detail(content.id),
    enabled: !isPlaylist && !pickedLayout,
  });
  const playlistData = isPlaylist ? playlist.data : undefined;
  const layoutData = !isPlaylist ? (pickedLayout ?? layout.data) : undefined;
  const loading = isPlaylist
    ? !playlistData && playlist.isLoading
    : !layoutData && layout.isLoading;
  const measuring = isPlaylist && playlist.isPlaceholderData;
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
        {loading || measuring ? (
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

function presentationMeta(
  kind: PresentationChoice["kind"],
  playlist: Playlist | undefined,
  layout: LayoutSummary | undefined,
  t: SchedulesT,
) {
  if (kind === "layout") {
    return layout?.publishedRevision
      ? t("editor.presentation.layoutMeta", {
          revision: layout.publishedRevision,
        })
      : t("editor.presentation.layoutKind");
  }
  if (!playlist) return t("editor.presentation.playlistKind");
  if (!playlist.itemCount) return t("editor.presentation.playlistEmpty");
  return t("editor.presentation.playlistMeta", {
    count: playlist.itemCount,
    duration: playlistDuration(playlist, t),
  });
}

/** "4 min 20 sec", or why there is no total: nothing in it, or live-length items. */
export function playlistDuration(playlist: Playlist, t: SchedulesT) {
  if (!playlist.items?.length) return t("editor.presentation.durationVaries");
  const seconds = playlist.items.reduce(
    (total, item) =>
      total +
      (item.durationMs
        ? item.durationMs / 1000
        : (item.assetDurationSeconds ?? 0)),
    0,
  );
  if (!seconds) return t("editor.presentation.durationVaries");
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes
    ? `${t("duration.minutes", { count: minutes })}${remainder ? ` ${t("duration.seconds", { count: remainder })}` : ""}`
    : t("duration.seconds", { count: remainder });
}

function DisplayControlFields({ session }: { session: ScheduleEditorSession }) {
  const { t } = useTranslation("schedules");
  const { draft, update, errors, readOnly } = session;
  const action = draft.displayAction;
  const problem = errors.displayAction
    ? problemMessage(errors.displayAction, t)
    : null;
  const setAction = (next: DisplayControlAction) =>
    update({ displayAction: next });
  const options = displayActionOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const level =
    action.type === "display_set_volume"
      ? action.volume
      : action.type === "display_set_brightness"
        ? action.brightness
        : undefined;
  return (
    <div className="grid gap-4">
      <Field>
        <FieldLabel htmlFor="schedule-display-action">
          {t("displayAction.actionLabel")}
        </FieldLabel>
        <Select
          items={options}
          value={action.type}
          disabled={readOnly}
          onValueChange={(next) => {
            if (next) setAction({ type: next });
          }}
        >
          <SelectTrigger
            id="schedule-display-action"
            className="w-full sm:w-64"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {action.type === "display_set_input" && (
        <Field data-invalid={problem ? true : undefined}>
          <FieldLabel htmlFor="schedule-display-value">
            {t("displayAction.inputLabel")}
          </FieldLabel>
          <Input
            id="schedule-display-value"
            value={action.input ?? ""}
            maxLength={DISPLAY_INPUT_MAX}
            required
            readOnly={readOnly}
            className="sm:w-64"
            aria-invalid={problem ? true : undefined}
            aria-describedby={
              problem ? "schedule-display-error" : "schedule-display-hint"
            }
            onChange={(event) =>
              setAction({ ...action, input: event.target.value })
            }
          />
          <FieldDescription id="schedule-display-hint">
            {t("displayAction.inputHint")}
          </FieldDescription>
        </Field>
      )}
      {(action.type === "display_set_volume" ||
        action.type === "display_set_brightness") && (
        <Field data-invalid={problem ? true : undefined}>
          <FieldLabel htmlFor="schedule-display-value">
            {action.type === "display_set_volume"
              ? t("displayAction.volumeLabel")
              : t("displayAction.brightnessLabel")}
          </FieldLabel>
          <Input
            id="schedule-display-value"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={level ?? ""}
            required
            readOnly={readOnly}
            className="sm:w-32"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? "schedule-display-error" : undefined}
            onChange={(event) => {
              const value =
                event.target.value === ""
                  ? undefined
                  : Number(event.target.value);
              setAction(
                action.type === "display_set_volume"
                  ? { type: action.type, volume: value }
                  : { type: action.type, brightness: value },
              );
            }}
          />
        </Field>
      )}
      {problem && (
        <FieldError id="schedule-display-error">{problem}</FieldError>
      )}
      <Alert>
        <AlertDescription>{t("displayAction.note")}</AlertDescription>
      </Alert>
    </div>
  );
}
