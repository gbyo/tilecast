import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import {
  Archive,
  CalendarRange,
  Plus,
  RotateCcw,
  Save,
  Send,
} from "lucide-react";
import { api } from "../api/client";
import type {
  Campaign,
  CampaignBlock,
  CampaignDestination,
  CampaignSnapshot,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Notice,
  PageHeader,
} from "../components/legacy-ui";
import { WorkspaceTabs, presentationTabs } from "../navigation/WorkspaceTabs";

function nextHour() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return date.toISOString();
}

function makeBlock(
  type: CampaignBlock["contentType"],
  contentId: string,
): CampaignBlock {
  const start = new Date(Date.now() + 5 * 60 * 1000);
  start.setSeconds(0, 0);
  return {
    id: crypto.randomUUID(),
    name: "Campaign block",
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

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
    onSuccess: (campaign) => void navigate(`/campaigns/${campaign.id}`),
  });
  const closeCreate = () => {
    setCreating(false);
    setName("");
    create.reset();
  };

  return (
    <section>
      <WorkspaceTabs label="Presentations" tabs={presentationTabs} />
      <PageHeader
        title="Campaigns"
        description="Coordinate immutable content releases across screens and groups. A release reuses the scheduler and never changes what is live until it is published."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" /> Create campaign
            </Button>
          ) : undefined
        }
      />
      {query.isLoading ? (
        <div className="table-loading">Loading campaigns…</div>
      ) : !query.data?.items.length ? (
        <EmptyState
          icon={<CalendarRange size={24} aria-hidden="true" />}
          title="No campaigns yet"
          message="Create a campaign to coordinate content and destinations in one reviewed release."
        />
      ) : (
        <div className="backup-list">
          {query.data.items.map((campaign) => (
            <Link
              className="backup-row"
              to={`/campaigns/${campaign.id}`}
              key={campaign.id}
            >
              <div className="backup-row__details">
                <strong>{campaign.name}</strong>
                <span>{campaign.description || "No description"}</span>
                <span>
                  {campaign.draft.blocks.length} blocks ·{" "}
                  {campaign.draft.destinations.length} destinations
                </span>
              </div>
              <span className="status-badge status-badge--recent">
                {campaign.status}
              </span>
            </Link>
          ))}
        </div>
      )}
      <Dialog open={creating} title="Create campaign" onClose={closeCreate}>
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {create.error && (
          <Notice variant="danger">{create.error.message}</Notice>
        )}
        <div className="form-actions">
          <Button variant="quiet" onClick={closeCreate}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create campaign
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function CampaignEditor({ campaignId }: { campaignId: string }) {
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
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void navigate("/campaigns");
    },
  });

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
    return <Notice variant="danger">{campaignQuery.error.message}</Notice>;
  if (campaignQuery.isLoading || !draft)
    return <div className="table-loading">Loading campaign…</div>;
  const campaign = campaignQuery.data;
  if (!campaign) return <Notice variant="danger">Campaign not found.</Notice>;

  const addBlock = () => {
    if (!selectedContent) return;
    setDraft({
      ...draft,
      blocks: [...draft.blocks, makeBlock(selectedType, selectedContent)],
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
    <section>
      <WorkspaceTabs label="Presentations" tabs={presentationTabs} />
      <PageHeader
        title={campaign.name}
        description={`${campaign.status} · draft ${campaign.draftRevision}. Changes remain private until this draft is submitted and published.`}
        actions={
          <div className="form-actions">
            <Button
              onClick={() => void preflightRun.mutate()}
              disabled={preflightRun.isPending}
            >
              Preflight
            </Button>
            {canEdit && (
              <Button
                variant="primary"
                onClick={() => save.mutate()}
                disabled={save.isPending}
              >
                <Save size={16} /> Save draft
              </Button>
            )}
            {canPublish && (
              <Button
                variant="primary"
                onClick={() => publish.mutate()}
                disabled={publish.isPending}
              >
                <Send size={16} /> Submit / publish
              </Button>
            )}
            {canEdit && (
              <Button
                onClick={() => {
                  if (
                    window.confirm(
                      "Archive this campaign and stop its schedules?",
                    )
                  ) {
                    archive.mutate();
                  }
                }}
                disabled={archive.isPending}
              >
                <Archive size={16} /> Archive
              </Button>
            )}
          </div>
        }
      />
      {(save.error ||
        publish.error ||
        restore.error ||
        restorePublication.error ||
        rollback.error) && (
        <Notice variant="danger">
          {
            (
              save.error ||
              publish.error ||
              restore.error ||
              restorePublication.error ||
              rollback.error
            )?.message
          }
        </Notice>
      )}
      {archive.error && (
        <Notice variant="danger">{archive.error.message}</Notice>
      )}
      {publish.isSuccess && (
        <Notice variant="info">
          The campaign was submitted or published. Review the submission status
          in Content review.
        </Notice>
      )}

      <div className="settings-sections">
        <section className="settings-subsection">
          <header>
            <h3>Draft definition</h3>
            <p>
              Every field below is part of the next immutable campaign release.
            </p>
          </header>
          <div className="form-grid">
            <Field label="Name">
              <input
                value={draft.name}
                disabled={!canEdit}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </Field>
            <Field label="Timezone">
              <input
                value={draft.timezone}
                disabled={!canEdit}
                onChange={(event) =>
                  setDraft({ ...draft, timezone: event.target.value })
                }
              />
            </Field>
            <Field label="Campaign start">
              <input
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
            <Field label="Campaign end">
              <input
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
          <Field label="Description">
            <textarea
              value={draft.description}
              disabled={!canEdit}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </Field>
        </section>

        <section className="settings-subsection">
          <header>
            <h3>Content blocks</h3>
            <p>
              Blocks become ordinary schedules when their release is published.
            </p>
          </header>
          {draft.blocks.map((block, index) => (
            <div className="backup-row campaign-block-row" key={block.id}>
              <div className="backup-row__details">
                {canEdit ? (
                  <input
                    aria-label={`Block ${index + 1} name`}
                    value={block.name}
                    onChange={(event) =>
                      updateBlock(block.id, { name: event.target.value })
                    }
                  />
                ) : (
                  <strong>{block.name}</strong>
                )}
                <span>
                  {block.contentType} · {block.type} · {block.timezone}
                </span>
                <span>
                  {block.type === "one_time"
                    ? `${new Date(block.oneTimeStart ?? "").toLocaleString()} – ${new Date(block.oneTimeEnd ?? "").toLocaleString()}`
                    : `${block.dailyStart ?? ""} – ${block.dailyEnd ?? ""}`}
                </span>
                {canEdit && (
                  <div className="form-grid">
                    <Field label="Schedule type">
                      <select
                        value={block.type}
                        onChange={(event) =>
                          updateBlock(block.id, {
                            type: event.target.value as CampaignBlock["type"],
                          })
                        }
                      >
                        <option value="one_time">Fixed time</option>
                        <option value="weekly">Weekly window</option>
                      </select>
                    </Field>
                    <Field label="Timezone">
                      <input
                        value={block.timezone}
                        onChange={(event) =>
                          updateBlock(block.id, {
                            timezone: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field label="Priority">
                      <input
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
                    <label className="field field--checkbox">
                      <span className="field__label">Enabled</span>
                      <input
                        type="checkbox"
                        checked={block.enabled}
                        onChange={(event) =>
                          updateBlock(block.id, {
                            enabled: event.target.checked,
                          })
                        }
                      />
                    </label>
                    {block.type === "one_time" ? (
                      <>
                        <Field label="Starts">
                          <input
                            type="datetime-local"
                            value={dateTimeInput(block.oneTimeStart)}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                oneTimeStart: dateTimeValue(event.target.value),
                              })
                            }
                          />
                        </Field>
                        <Field label="Ends">
                          <input
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
                        <Field label="Date range start">
                          <input
                            type="date"
                            value={block.startDate ?? ""}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                startDate: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                        <Field label="Date range end">
                          <input
                            type="date"
                            value={block.endDate ?? ""}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                endDate: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                        <Field label="Daily start">
                          <input
                            type="time"
                            value={block.dailyStart ?? ""}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                dailyStart: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                        <Field label="Daily end">
                          <input
                            type="time"
                            value={block.dailyEnd ?? ""}
                            onChange={(event) =>
                              updateBlock(block.id, {
                                dailyEnd: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                        <fieldset className="field campaign-weekdays">
                          <legend className="field__label">Weekdays</legend>
                          {weekdayLabels.map((label, day) => (
                            <label key={label}>
                              <input
                                type="checkbox"
                                checked={(block.daysOfWeek ?? []).includes(day)}
                                onChange={(event) => {
                                  const days = new Set(block.daysOfWeek ?? []);
                                  if (event.target.checked) days.add(day);
                                  else days.delete(day);
                                  updateBlock(block.id, {
                                    daysOfWeek: [...days].sort((a, b) => a - b),
                                  });
                                }}
                              />
                              {label}
                            </label>
                          ))}
                        </fieldset>
                      </>
                    )}
                  </div>
                )}
              </div>
              {canEdit && (
                <Button
                  onClick={() =>
                    setDraft({
                      ...draft,
                      blocks: draft.blocks.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {canEdit && (
            <div className="form-grid">
              <Field label="Content type">
                <select
                  value={selectedType}
                  onChange={(event) => {
                    setSelectedType(
                      event.target.value as CampaignBlock["contentType"],
                    );
                    setSelectedContent("");
                  }}
                >
                  <option value="playlist">Playlist</option>
                  <option value="layout">Layout</option>
                </select>
              </Field>
              <Field label="Content">
                <select
                  value={selectedContent}
                  onChange={(event) => setSelectedContent(event.target.value)}
                >
                  <option value="">Select content</option>
                  {contentOptions.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Button onClick={addBlock} disabled={!selectedContent}>
                <Plus size={16} /> Add block
              </Button>
            </div>
          )}
        </section>

        <section className="settings-subsection">
          <header>
            <h3>Destinations</h3>
            <p>Choose the screens or groups that receive this release.</p>
          </header>
          <div className="backup-list">
            {draft.destinations.map((item) => (
              <div className="backup-row" key={`${item.type}:${item.id}`}>
                <span>
                  {item.type} ·{" "}
                  {destinationLabel(
                    item,
                    screens.data?.items ?? [],
                    groups.data?.items ?? [],
                  )}
                </span>
                {canEdit && (
                  <Button
                    onClick={() =>
                      setDraft({
                        ...draft,
                        destinations: draft.destinations.filter(
                          (candidate) => candidate !== item,
                        ),
                      })
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
          {canEdit && (
            <div className="form-grid">
              <Field label="Destination type">
                <select
                  value={destinationType}
                  onChange={(event) => {
                    setDestinationType(
                      event.target.value as CampaignDestination["type"],
                    );
                    setDestination("");
                  }}
                >
                  <option value="screen">Screen</option>
                  <option value="group">Group</option>
                </select>
              </Field>
              <Field label="Destination">
                <select
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                >
                  <option value="">Select destination</option>
                  {destinationOptions.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Button onClick={addDestination} disabled={!destination}>
                <Plus size={16} /> Add destination
              </Button>
            </div>
          )}
        </section>

        <section className="settings-subsection">
          <header>
            <h3>Preflight</h3>
            <p>
              Publication checks referenced content, schedule windows, and
              destination membership before any schedule changes are committed.
            </p>
          </header>
          {preflight.data && (
            <Notice
              variant={
                preflight.data.valid
                  ? preflight.data.issues.length
                    ? "info"
                    : "success"
                  : "danger"
              }
            >
              <div>
                {preflight.data.valid
                  ? `Ready: ${preflight.data.blockCount} blocks can reach ${preflight.data.destinationCount} destinations.`
                  : "The campaign cannot be published yet."}
              </div>
              {preflight.data.issues.map((issue) => (
                <div key={`${issue.code}:${issue.message}`}>
                  {issue.severity}: {issue.message}
                </div>
              ))}
            </Notice>
          )}
        </section>

        <section className="settings-subsection">
          <header>
            <h3>Release history</h3>
            <p>
              Releases are immutable. Restoring one returns it to the draft for
              review; it never rewrites history.
            </p>
          </header>
          {releases.data?.items.map((release) => (
            <div className="backup-row" key={release.id}>
              <div className="backup-row__details">
                <strong>Release {release.releaseNumber}</strong>
                <span>
                  {release.status} ·{" "}
                  {release.publishedAt
                    ? new Date(release.publishedAt).toLocaleString()
                    : "not published"}
                </span>
              </div>
              {canEdit && (
                <Button
                  onClick={() => restore.mutate(release.id)}
                  disabled={restore.isPending}
                >
                  <RotateCcw size={16} /> Restore to draft
                </Button>
              )}
            </div>
          ))}
        </section>

        <section className="settings-subsection">
          <header>
            <h3>Publication history</h3>
            <p>
              Deployment history is separate from the security audit log.
              Restore creates a draft; rollback creates a new release.
            </p>
          </header>
          {history.data?.items.map((publication) => (
            <div className="backup-row" key={publication.id}>
              <div className="backup-row__details">
                <strong>Release {publication.revision}</strong>
                <span>
                  {publication.method} ·{" "}
                  {new Date(publication.publishedAt).toLocaleString()} ·{" "}
                  {publication.affectedScreenCount} screens
                </span>
              </div>
              <div className="form-actions">
                {canEdit && (
                  <Button
                    onClick={() => restorePublication.mutate(publication.id)}
                    disabled={restorePublication.isPending}
                  >
                    Restore as draft
                  </Button>
                )}
                {canPublish && (
                  <Button
                    onClick={() => rollback.mutate(publication.id)}
                    disabled={rollback.isPending}
                  >
                    Roll back to this release
                  </Button>
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
