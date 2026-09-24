import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Link, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Archive,
  CalendarRange,
  Plus,
  RotateCcw,
  Save,
  Send,
} from "lucide-react";
import { api } from "../api/client";
import { useFormatLocale } from "../i18n";
import type {
  Campaign,
  CampaignBlock,
  CampaignDestination,
  CampaignSnapshot,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog as RheaAlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
import { Checkbox as RheaCheckbox } from "../components/ui/checkbox";
import {
  Dialog as RheaDialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toast";

function nextHour() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return date.toISOString();
}

function makeBlock(
  type: CampaignBlock["contentType"],
  contentId: string,
  t: TFunction<"alerts">,
): CampaignBlock {
  const start = new Date(Date.now() + 5 * 60 * 1000);
  start.setSeconds(0, 0);
  return {
    id: crypto.randomUUID(),
    name: t("campaigns.editor.defaultBlockName"),
    contentType: type,
    contentId,
    priority: 0,
    type: "one_time",
    timezone: "UTC",
    oneTimeStart: start.toISOString(),
    oneTimeEnd: nextHour(),
    enabled: true,
  };
}

function snapshotForEdit(campaign: Campaign): CampaignSnapshot {
  return {
    ...campaign.draft,
    destinations: [...(campaign.draft.destinations ?? [])],
    blocks: [...(campaign.draft.blocks ?? [])],
  };
}

const blockScheduleOptions = [
  { value: "one_time", labelKey: "campaigns.editor.scheduleTypes.oneTime" },
  { value: "weekly", labelKey: "campaigns.editor.scheduleTypes.weekly" },
] as const;

const blockContentOptions = [
  { value: "playlist", labelKey: "campaigns.editor.contentTypes.playlist" },
  { value: "layout", labelKey: "campaigns.editor.contentTypes.layout" },
] as const;

const destinationTypeOptions = [
  { value: "screen", labelKey: "campaigns.editor.destinationTypes.screen" },
  { value: "group", labelKey: "campaigns.editor.destinationTypes.group" },
] as const;

function dateTimeInput(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateTimeValue(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

export function CampaignsPage() {
  const { id } = useParams();
  return id ? <CampaignEditor campaignId={id} /> : <CampaignLibrary />;
}

function CampaignLibrary() {
  const { t } = useTranslation(["alerts", "common"]);
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const canCreate = ["owner", "administrator", "editor"].includes(
    auth.status?.user?.role ?? "viewer",
  );
  const query = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns(),
  });
  const create = useMutation({
    mutationFn: () =>
      api.createCampaign({ name: name.trim(), timezone: "UTC" }, csrf),
    onSuccess: (campaign) => {
      toast.add({ title: "Campaign created.", type: "success" });
      void navigate(`/campaigns/${campaign.id}`);
    },
  });
  const closeCreate = () => {
    setCreating(false);
    setName("");
    create.reset();
  };

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("campaigns.library.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("campaigns.library.description")}
          </p>
        </div>
        {canCreate && (
          <div className="flex flex-wrap items-center gap-2">
            <RheaButton type="button" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" />{" "}
              {t("campaigns.library.createButton")}
            </RheaButton>
          </div>
        )}
      </header>
      {query.isLoading ? (
        <div className="grid gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : !query.data?.items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarRange size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("campaigns.library.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("campaigns.library.emptyBody")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-2">
          {query.data.items.map((campaign) => (
            <Link
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-border p-3 hover:bg-muted"
              to={`/campaigns/${campaign.id}`}
              key={campaign.id}
            >
              <div className="grid min-w-0 gap-0.5">
                <strong className="truncate text-sm">{campaign.name}</strong>
                <span className="truncate text-xs text-muted-foreground">
                  {campaign.description || t("campaigns.library.noDescription")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("campaigns.library.listMeta", {
                    blocks: t("campaigns.library.blockCount", {
                      count: campaign.draft.blocks.length,
                    }),
                    destinations: t("campaigns.library.destinationCount", {
                      count: campaign.draft.destinations.length,
                    }),
                  })}
                </span>
              </div>
              <Badge variant="secondary">{campaign.status}</Badge>
            </Link>
          ))}
        </div>
      )}
      <RheaDialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) closeCreate();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("campaigns.library.createTitle")}</DialogTitle>
            <DialogDescription>
              {t("campaigns.library.createDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="campaign-create-name">
                {t("campaigns.library.nameLabel")}
              </FieldLabel>
              <Input
                id="campaign-create-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            {create.error && (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <RheaButton type="button" variant="outline" onClick={closeCreate}>
              {t("common:actions.cancel")}
            </RheaButton>
            <RheaButton
              type="button"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending
                ? t("campaigns.library.creating")
                : t("campaigns.library.createSubmit")}
            </RheaButton>
          </DialogFooter>
        </DialogContent>
      </RheaDialog>
    </section>
  );
}

function CampaignEditor({ campaignId }: { campaignId: string }) {
  const { t } = useTranslation(["alerts", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const navigate = useNavigate();
  const role = auth.status?.user?.role ?? "viewer";
  const canEdit = ["owner", "administrator", "editor"].includes(role);
  const canPublish = ["owner", "administrator"].includes(role);
  const queryClient = useQueryClient();
  const campaignQuery = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: () => api.campaign(campaignId),
  });
  const playlists = useQuery({
    queryKey: ["playlists", "campaign-picker"],
    queryFn: () => api.playlists(),
  });
  const layouts = useQuery({
    queryKey: ["layouts", "campaign-picker"],
    queryFn: () => api.layouts(),
  });
  const screens = useQuery({
    queryKey: ["screens", "campaign-picker"],
    queryFn: api.screens,
  });
  const groups = useQuery({
    queryKey: ["screen-groups", "campaign-picker"],
    queryFn: () => api.screenGroups(),
  });
  const preflight = useQuery({
    queryKey: ["campaign-preflight", campaignId],
    queryFn: () => api.campaignPreflight(campaignId),
    enabled: Boolean(campaignQuery.data),
  });
  const releases = useQuery({
    queryKey: ["campaign-releases", campaignId],
    queryFn: () => api.campaignReleases(campaignId),
    enabled: Boolean(campaignQuery.data),
  });
  const history = useQuery({
    queryKey: ["publication-history", "campaign", campaignId],
    queryFn: () => api.publicationHistory("campaign", campaignId),
    enabled: Boolean(campaignQuery.data),
  });
  const [draft, setDraft] = useState<CampaignSnapshot>();
  const [selectedType, setSelectedType] =
    useState<CampaignBlock["contentType"]>("playlist");
  const [selectedContent, setSelectedContent] = useState("");
  const [destinationType, setDestinationType] =
    useState<CampaignDestination["type"]>("screen");
  const [destination, setDestination] = useState("");
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  useEffect(() => {
    if (campaignQuery.data) {
      setDraft((current) => current ?? snapshotForEdit(campaignQuery.data));
    }
  }, [campaignQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateCampaignDraft(
        campaignId,
        campaignQuery.data?.draftRevision ?? 0,
        draft!,
        csrf,
      ),
    onSuccess: (campaign) => {
      toast.add({ title: "Campaign draft saved.", type: "success" });
      setDraft(snapshotForEdit(campaign));
      void queryClient.invalidateQueries({
        queryKey: ["campaign", campaignId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["campaign-preflight", campaignId],
      });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
  const preflightRun = useMutation({
    mutationFn: () => api.campaignPreflight(campaignId),
    onSuccess: (result) =>
      queryClient.setQueryData(["campaign-preflight", campaignId], result),
  });
  const publish = useMutation({
    mutationFn: () =>
      api.publishCampaign(
        campaignId,
        campaignQuery.data?.draftRevision ?? 0,
        csrf,
      ),
    onSuccess: () => {
      toast.add({ title: "Campaign published.", type: "success" });
      void queryClient.invalidateQueries({
        queryKey: ["campaign", campaignId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["campaign-preflight", campaignId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["campaign-releases", campaignId],
      });
      void queryClient.invalidateQueries({ queryKey: ["content-submissions"] });
    },
  });
  const restore = useMutation({
    mutationFn: (releaseId: string) =>
      api.restoreCampaignRelease(campaignId, releaseId, csrf),
    onSuccess: (campaign) => {
      toast.add({
        title: "Campaign release restored to draft.",
        type: "success",
      });
      setDraft(snapshotForEdit(campaign));
      void queryClient.invalidateQueries({
        queryKey: ["campaign", campaignId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["campaign-preflight", campaignId],
      });
    },
  });
  const restorePublication = useMutation({
    mutationFn: (publicationId: string) =>
      api.restorePublicationToDraft(
        "campaign",
        campaignId,
        publicationId,
        csrf,
      ),
    onSuccess: async () => {
      toast.add({ title: "Publication restored to draft.", type: "success" });
      setDraft(undefined);
      await queryClient.invalidateQueries({
        queryKey: ["campaign", campaignId],
      });
      const restored = queryClient.getQueryData<Campaign>([
        "campaign",
        campaignId,
      ]);
      if (restored) setDraft(snapshotForEdit(restored));
      void queryClient.invalidateQueries({
        queryKey: ["campaign-preflight", campaignId],
      });
    },
  });
  const rollback = useMutation({
    mutationFn: (publicationId: string) =>
      api.rollbackPublication("campaign", campaignId, publicationId, csrf),
    onSuccess: () => {
      toast.add({ title: "Publication rolled back.", type: "success" });
      void queryClient.invalidateQueries({
        queryKey: ["campaign", campaignId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["campaign-releases", campaignId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["publication-history", "campaign", campaignId],
      });
      void queryClient.invalidateQueries({ queryKey: ["content-submissions"] });
    },
  });
  const archive = useMutation({
    mutationFn: () => api.archiveCampaign(campaignId, csrf),
    onSuccess: () => {
      toast.add({ title: "Campaign archived.", type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void navigate("/campaigns");
    },
  });

  const scheduleTypeOptions = useMemo(
    () =>
      blockScheduleOptions.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
    [t],
  );
  const contentTypeOptions = useMemo(
    () =>
      blockContentOptions.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
    [t],
  );
  const destinationTypeSelectOptions = useMemo(
    () =>
      destinationTypeOptions.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
    [t],
  );
  // Short weekday names in the interface language. 2024-01-07 was a Sunday.
  const weekdayNames = useMemo(
    () =>
      Array.from({ length: 7 }, (_, day) =>
        new Date(2024, 0, 7 + day).toLocaleDateString(locale, {
          weekday: "short",
        }),
      ),
    [locale],
  );
  const contentOptions = useMemo(
    () =>
      selectedType === "playlist"
        ? (playlists.data?.items ?? []).map((item) => ({
            id: item.id,
            name: item.name,
          }))
        : (layouts.data?.items ?? []).map((item) => ({
            id: item.id,
            name: item.name,
          })),
    [layouts.data?.items, playlists.data?.items, selectedType],
  );
  const destinationOptions =
    destinationType === "screen"
      ? (screens.data?.items.map((item) => ({
          id: item.id,
          name: item.name,
        })) ?? [])
      : (groups.data?.items.map((item) => ({ id: item.id, name: item.name })) ??
        []);

  if (campaignQuery.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{campaignQuery.error.message}</AlertDescription>
      </Alert>
    );
  if (campaignQuery.isLoading || !draft)
    return (
      <div className="grid gap-2">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  const campaign = campaignQuery.data;
  if (!campaign)
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("campaigns.editor.notFound")}</AlertDescription>
      </Alert>
    );

  const addBlock = () => {
    if (!selectedContent) return;
    setDraft({
      ...draft,
      blocks: [...draft.blocks, makeBlock(selectedType, selectedContent, t)],
    });
    setSelectedContent("");
  };
  const addDestination = () => {
    if (
      !destination ||
      draft.destinations.some(
        (item) => item.type === destinationType && item.id === destination,
      )
    )
      return;
    setDraft({
      ...draft,
      destinations: [
        ...draft.destinations,
        { type: destinationType, id: destination },
      ],
    });
    setDestination("");
  };
  const updateBlock = (blockID: string, patch: Partial<CampaignBlock>) => {
    setDraft({
      ...draft,
      blocks: draft.blocks.map((block) =>
        block.id === blockID ? { ...block, ...patch } : block,
      ),
    });
  };

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {campaign.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("campaigns.editor.subtitle", {
              status: campaign.status,
              revision: campaign.draftRevision,
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RheaButton
            type="button"
            variant="outline"
            onClick={() => void preflightRun.mutate()}
            disabled={preflightRun.isPending}
          >
            {t("campaigns.editor.preflightButton")}
          </RheaButton>
          {canEdit && (
            <RheaButton
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending}
            >
              <Save size={16} aria-hidden="true" />{" "}
              {t("campaigns.editor.saveDraft")}
            </RheaButton>
          )}
          {canPublish && (
            <RheaButton
              type="button"
              onClick={() => publish.mutate()}
              disabled={publish.isPending}
            >
              <Send size={16} aria-hidden="true" />{" "}
              {t("campaigns.editor.submitPublish")}
            </RheaButton>
          )}
          {canEdit && (
            <RheaButton
              type="button"
              variant="outline"
              onClick={() => setConfirmingArchive(true)}
              disabled={archive.isPending}
            >
              <Archive size={16} aria-hidden="true" />{" "}
              {t("campaigns.editor.archiveButton")}
            </RheaButton>
          )}
        </div>
      </header>
      <RheaAlertDialog
        open={confirmingArchive}
        onOpenChange={(open) => {
          if (!open) setConfirmingArchive(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("campaigns.editor.archiveTitle", { name: campaign.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("campaigns.editor.archiveBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={archive.isPending}
              onClick={() => {
                setConfirmingArchive(false);
                archive.mutate();
              }}
            >
              {t("campaigns.editor.archiveConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </RheaAlertDialog>
      {(save.error ||
        publish.error ||
        restore.error ||
        restorePublication.error ||
        rollback.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {
              (
                save.error ||
                publish.error ||
                restore.error ||
                restorePublication.error ||
                rollback.error
              )?.message
            }
          </AlertDescription>
        </Alert>
      )}
      {archive.error && (
        <Alert variant="destructive">
          <AlertDescription>{archive.error.message}</AlertDescription>
        </Alert>
      )}
      {publish.isSuccess && (
        <Alert>
          <AlertDescription>
            {t("campaigns.editor.publishedNotice")}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6">
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("campaigns.editor.draftTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("campaigns.editor.draftHint")}
            </p>
          </header>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="campaign-name">
                {t("campaigns.editor.nameLabel")}
              </FieldLabel>
              <Input
                id="campaign-name"
                value={draft.name}
                disabled={!canEdit}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="campaign-timezone">
                {t("campaigns.editor.timezoneLabel")}
              </FieldLabel>
              <Input
                id="campaign-timezone"
                value={draft.timezone}
                disabled={!canEdit}
                onChange={(event) =>
                  setDraft({ ...draft, timezone: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="campaign-start">
                {t("campaigns.editor.startLabel")}
              </FieldLabel>
              <Input
                id="campaign-start"
                type="datetime-local"
                value={dateTimeInput(draft.campaignStart)}
                disabled={!canEdit}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    campaignStart: dateTimeValue(event.target.value),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="campaign-end">
                {t("campaigns.editor.endLabel")}
              </FieldLabel>
              <Input
                id="campaign-end"
                type="datetime-local"
                value={dateTimeInput(draft.campaignEnd)}
                disabled={!canEdit}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    campaignEnd: dateTimeValue(event.target.value),
                  })
                }
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="campaign-description">
              {t("campaigns.editor.descriptionLabel")}
            </FieldLabel>
            <Textarea
              id="campaign-description"
              value={draft.description}
              disabled={!canEdit}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </Field>
        </section>

        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("campaigns.editor.blocksTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("campaigns.editor.blocksHint")}
            </p>
          </header>
          {draft.blocks.map((block, index) => (
            <div
              className="grid gap-3 rounded-lg border border-border p-3"
              key={block.id}
            >
              <div className="grid gap-1">
                {canEdit ? (
                  <Input
                    aria-label={t("campaigns.editor.blockNameLabel", {
                      index: index + 1,
                    })}
                    value={block.name}
                    onChange={(event) =>
                      updateBlock(block.id, { name: event.target.value })
                    }
                  />
                ) : (
                  <strong className="text-sm">{block.name}</strong>
                )}
                <span className="text-xs text-muted-foreground">
                  {block.contentType} · {block.type} · {block.timezone}
                </span>
                <span className="text-xs text-muted-foreground">
                  {block.type === "one_time"
                    ? `${new Date(block.oneTimeStart ?? "").toLocaleString(locale)} – ${new Date(block.oneTimeEnd ?? "").toLocaleString(locale)}`
                    : `${block.dailyStart ?? ""} – ${block.dailyEnd ?? ""}`}
                </span>
                {canEdit && (
                  <div className="grid gap-4 pt-2 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor={`block-type-${block.id}`}>
                        {t("campaigns.editor.scheduleTypeLabel")}
                      </FieldLabel>
                      <RheaSelect
                        value={block.type}
                        onValueChange={(next) =>
                          updateBlock(block.id, {
                            type: next as CampaignBlock["type"],
                          })
                        }
                        items={blockScheduleOptions}
                      >
                        <SelectTrigger
                          id={`block-type-${block.id}`}
                          aria-label={t("campaigns.editor.scheduleTypeAria", {
                            index: index + 1,
                          })}
                        >
                          <SelectValue>
                            {optionLabel(scheduleTypeOptions, block.type)}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {scheduleTypeOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </RheaSelect>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`block-timezone-${block.id}`}>
                        {t("campaigns.editor.blockTimezoneLabel")}
                      </FieldLabel>
                      <Input
                        id={`block-timezone-${block.id}`}
                        value={block.timezone}
                        onChange={(event) =>
                          updateBlock(block.id, {
                            timezone: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`block-priority-${block.id}`}>
                        {t("campaigns.editor.priorityLabel")}
                      </FieldLabel>
                      <Input
                        id={`block-priority-${block.id}`}
                        type="number"
                        min="0"
                        value={block.priority}
                        onChange={(event) =>
                          updateBlock(block.id, {
                            priority: Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                    {/* The wrapping label names the checkbox; no extra
                        aria-label. */}
                    <label className="flex items-center gap-2 text-sm">
                      <RheaCheckbox
                        checked={block.enabled}
                        onCheckedChange={(checked) =>
                          updateBlock(block.id, {
                            enabled: checked === true,
                          })
                        }
                      />
                      <span>{t("campaigns.editor.enabledLabel")}</span>
                    </label>
                    {block.type === "one_time" ? (
                      <>
                        <Field>
                          <FieldLabel htmlFor={`block-start-${block.id}`}>
                            {t("campaigns.editor.startsLabel")}
                          </FieldLabel>
                          <Input
                            id={`block-start-${block.id}`}
                            type="datetime-local"
                            value={dateTimeInput(block.oneTimeStart)}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                oneTimeStart: dateTimeValue(event.target.value),
                              })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`block-end-${block.id}`}>
                            {t("campaigns.editor.endsLabel")}
                          </FieldLabel>
                          <Input
                            id={`block-end-${block.id}`}
                            type="datetime-local"
                            value={dateTimeInput(block.oneTimeEnd)}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                oneTimeEnd: dateTimeValue(event.target.value),
                              })
                            }
                          />
                        </Field>
                      </>
                    ) : (
                      <>
                        <Field>
                          <FieldLabel htmlFor={`block-range-start-${block.id}`}>
                            {t("campaigns.editor.rangeStartLabel")}
                          </FieldLabel>
                          <Input
                            id={`block-range-start-${block.id}`}
                            type="date"
                            value={block.startDate ?? ""}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                startDate: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`block-range-end-${block.id}`}>
                            {t("campaigns.editor.rangeEndLabel")}
                          </FieldLabel>
                          <Input
                            id={`block-range-end-${block.id}`}
                            type="date"
                            value={block.endDate ?? ""}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                endDate: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`block-daily-start-${block.id}`}>
                            {t("campaigns.editor.dailyStartLabel")}
                          </FieldLabel>
                          <Input
                            id={`block-daily-start-${block.id}`}
                            type="time"
                            value={block.dailyStart ?? ""}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                dailyStart: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`block-daily-end-${block.id}`}>
                            {t("campaigns.editor.dailyEndLabel")}
                          </FieldLabel>
                          <Input
                            id={`block-daily-end-${block.id}`}
                            type="time"
                            value={block.dailyEnd ?? ""}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                dailyEnd: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                        <fieldset className="grid gap-2 sm:col-span-2">
                          <legend className="text-sm font-medium">
                            {t("campaigns.editor.weekdaysLabel")}
                          </legend>
                          <div className="flex flex-wrap gap-x-4 gap-y-2">
                            {weekdayNames.map((label, day) => (
                              <label
                                key={label}
                                className="flex items-center gap-2 text-sm"
                              >
                                <RheaCheckbox
                                  checked={(block.daysOfWeek ?? []).includes(
                                    day,
                                  )}
                                  onCheckedChange={(checked) => {
                                    const days = new Set(
                                      block.daysOfWeek ?? [],
                                    );
                                    if (checked === true) days.add(day);
                                    else days.delete(day);
                                    updateBlock(block.id, {
                                      daysOfWeek: [...days].sort(
                                        (a, b) => a - b,
                                      ),
                                    });
                                  }}
                                />
                                <span>{label}</span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      </>
                    )}
                  </div>
                )}
              </div>
              {canEdit && (
                <RheaButton
                  type="button"
                  variant="outline"
                  className="w-fit"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      blocks: draft.blocks.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                >
                  {t("campaigns.editor.removeButton")}
                </RheaButton>
              )}
            </div>
          ))}
          {canEdit && (
            <div className="grid items-end gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="campaign-content-type">
                  {t("campaigns.editor.contentTypeLabel")}
                </FieldLabel>
                <RheaSelect
                  value={selectedType}
                  onValueChange={(next) => {
                    setSelectedType(next as CampaignBlock["contentType"]);
                    setSelectedContent("");
                  }}
                  items={blockContentOptions}
                >
                  <SelectTrigger
                    id="campaign-content-type"
                    aria-label={t("campaigns.editor.contentTypeLabel")}
                  >
                    <SelectValue>
                      {optionLabel(contentTypeOptions, selectedType)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {contentTypeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </RheaSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="campaign-content">
                  {t("campaigns.editor.contentLabel")}
                </FieldLabel>
                <RheaSelect
                  value={selectedContent}
                  onValueChange={(next) => setSelectedContent(next as string)}
                  items={[
                    { value: "", label: "Select content" },
                    ...contentOptions.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                >
                  <SelectTrigger
                    id="campaign-content"
                    aria-label={t("campaigns.editor.contentLabel")}
                  >
                    <SelectValue>
                      {optionLabel(
                        [
                          {
                            value: "",
                            label: t("campaigns.editor.selectContent"),
                          },
                          ...contentOptions.map((item) => ({
                            value: item.id,
                            label: item.name,
                          })),
                        ],
                        selectedContent,
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      {t("campaigns.editor.selectContent")}
                    </SelectItem>
                    {contentOptions.map((item) => (
                      <SelectItem value={item.id} key={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </RheaSelect>
              </Field>
              <RheaButton
                type="button"
                variant="outline"
                onClick={addBlock}
                disabled={!selectedContent}
              >
                <Plus size={16} aria-hidden="true" />{" "}
                {t("campaigns.editor.addBlock")}
              </RheaButton>
            </div>
          )}
        </section>

        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("campaigns.editor.destinationsTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("campaigns.editor.destinationsHint")}
            </p>
          </header>
          <div className="grid gap-2">
            {draft.destinations.map((item) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
                key={`${item.type}:${item.id}`}
              >
                <span className="text-sm">
                  {item.type} ·{" "}
                  {destinationLabel(
                    item,
                    screens.data?.items ?? [],
                    groups.data?.items ?? [],
                  )}
                </span>
                {canEdit && (
                  <RheaButton
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        destinations: draft.destinations.filter(
                          (candidate) => candidate !== item,
                        ),
                      })
                    }
                  >
                    {t("campaigns.editor.removeButton")}
                  </RheaButton>
                )}
              </div>
            ))}
          </div>
          {canEdit && (
            <div className="grid items-end gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="campaign-destination-type">
                  {t("campaigns.editor.destinationTypeLabel")}
                </FieldLabel>
                <RheaSelect
                  value={destinationType}
                  onValueChange={(next) => {
                    setDestinationType(next as CampaignDestination["type"]);
                    setDestination("");
                  }}
                  items={destinationTypeOptions}
                >
                  <SelectTrigger
                    id="campaign-destination-type"
                    aria-label={t("campaigns.editor.destinationTypeLabel")}
                  >
                    <SelectValue>
                      {optionLabel(
                        destinationTypeSelectOptions,
                        destinationType,
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {destinationTypeSelectOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </RheaSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="campaign-destination">
                  {t("campaigns.editor.destinationLabel")}
                </FieldLabel>
                <RheaSelect
                  value={destination}
                  onValueChange={(next) => setDestination(next as string)}
                  items={[
                    { value: "", label: "Select destination" },
                    ...destinationOptions.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                >
                  <SelectTrigger
                    id="campaign-destination"
                    aria-label={t("campaigns.editor.destinationLabel")}
                  >
                    <SelectValue>
                      {optionLabel(
                        [
                          {
                            value: "",
                            label: t("campaigns.editor.selectDestination"),
                          },
                          ...destinationOptions.map((item) => ({
                            value: item.id,
                            label: item.name,
                          })),
                        ],
                        destination,
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      {t("campaigns.editor.selectDestination")}
                    </SelectItem>
                    {destinationOptions.map((item) => (
                      <SelectItem value={item.id} key={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </RheaSelect>
              </Field>
              <RheaButton
                type="button"
                variant="outline"
                onClick={addDestination}
                disabled={!destination}
              >
                <Plus size={16} aria-hidden="true" />{" "}
                {t("campaigns.editor.addDestination")}
              </RheaButton>
            </div>
          )}
        </section>

        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("campaigns.editor.preflightTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("campaigns.editor.preflightHint")}
            </p>
          </header>
          {preflight.data && (
            <Alert variant={preflight.data.valid ? undefined : "destructive"}>
              <AlertDescription>
                <div>
                  {preflight.data.valid
                    ? t("campaigns.editor.readySummary", {
                        blocks: t("campaigns.editor.blockCount", {
                          count: preflight.data.blockCount,
                        }),
                        destinations: t("campaigns.editor.destinationCount", {
                          count: preflight.data.destinationCount,
                        }),
                      })
                    : t("campaigns.editor.notReady")}
                </div>
                {preflight.data.issues.map((issue) => (
                  <div key={`${issue.code}:${issue.message}`}>
                    {issue.severity}: {issue.message}
                  </div>
                ))}
              </AlertDescription>
            </Alert>
          )}
        </section>

        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("campaigns.editor.releasesTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("campaigns.editor.releasesHint")}
            </p>
          </header>
          {releases.data?.items.map((release) => (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
              key={release.id}
            >
              <div className="grid gap-0.5">
                <strong className="text-sm">
                  {t("campaigns.editor.releaseTitle", {
                    number: release.releaseNumber,
                  })}
                </strong>
                <span className="text-xs text-muted-foreground">
                  {t("campaigns.editor.releaseMeta", {
                    status: release.status,
                    date: release.publishedAt
                      ? new Date(release.publishedAt).toLocaleString(locale)
                      : t("campaigns.editor.notPublished"),
                  })}
                </span>
              </div>
              {canEdit && (
                <RheaButton
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => restore.mutate(release.id)}
                  disabled={restore.isPending}
                >
                  <RotateCcw size={16} aria-hidden="true" />{" "}
                  {t("campaigns.editor.restoreDraft")}
                </RheaButton>
              )}
            </div>
          ))}
        </section>

        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("campaigns.editor.publicationsTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("campaigns.editor.publicationsHint")}
            </p>
          </header>
          {history.data?.items.map((publication) => (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
              key={publication.id}
            >
              <div className="grid gap-0.5">
                <strong className="text-sm">
                  {t("campaigns.editor.releaseTitle", {
                    number: publication.revision,
                  })}
                </strong>
                <span className="text-xs text-muted-foreground">
                  {t("campaigns.editor.publicationMeta", {
                    method: publication.method,
                    date: new Date(publication.publishedAt).toLocaleString(
                      locale,
                    ),
                    screens: t("campaigns.editor.screenCount", {
                      count: publication.affectedScreenCount,
                    }),
                  })}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canEdit && (
                  <RheaButton
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => restorePublication.mutate(publication.id)}
                    disabled={restorePublication.isPending}
                  >
                    {t("campaigns.editor.restoreAsDraft")}
                  </RheaButton>
                )}
                {canPublish && (
                  <RheaButton
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => rollback.mutate(publication.id)}
                    disabled={rollback.isPending}
                  >
                    {t("campaigns.editor.rollbackToRelease")}
                  </RheaButton>
                )}
              </div>
            </div>
          ))}
        </section>
      </div>
    </section>
  );
}

function destinationLabel(
  item: CampaignDestination,
  screens: { id: string; name: string }[],
  groups: { id: string; name: string }[],
) {
  const source = item.type === "screen" ? screens : groups;
  return source.find((candidate) => candidate.id === item.id)?.name ?? item.id;
}
