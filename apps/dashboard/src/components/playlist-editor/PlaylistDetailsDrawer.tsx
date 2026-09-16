import { Save, Tag } from "lucide-react";
import { Button, Drawer, Field, Select } from "../ui";
import type { ContentTag } from "../../api/types";

export function PlaylistDetailsDrawer({
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
  return (
    <Drawer
      title="Playlist details"
      eyebrow={
        sourceType === "tag" ? "Tag-driven playlist" : "Playlist settings"
      }
      onClose={onClose}
      closeLabel="Close playlist details"
      className="playlist-details-drawer"
    >
      <div className="playlist-details-drawer__content">
        <section className="playlist-details-section">
          <div className="playlist-details-section__heading">
            <h3>Details</h3>
            <p>
              Name and description are saved separately from timeline edits.
            </p>
          </div>
          <div className="playlist-details-section__fields">
            <Field label="Name">
              <input
                disabled={!canManage}
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
              />
            </Field>
            <Field label="Description">
              <textarea
                disabled={!canManage}
                value={description}
                onChange={(event) => onDescriptionChange(event.target.value)}
              />
            </Field>
          </div>
          {metadataError && (
            <div
              className="playlist-editor-notice playlist-editor-notice--error"
              role="alert"
            >
              {metadataError}
            </div>
          )}
          <div className="playlist-details-section__actions">
            <Button
              variant="primary"
              compact
              loading={metadataSaving}
              disabled={!canManage || !metadataDirty}
              onClick={onSaveMetadata}
            >
              <Save size={14} aria-hidden="true" />
              Save details
            </Button>
          </div>
        </section>

        <section className="playlist-details-section">
          <div className="playlist-details-section__heading">
            <h3>Content source</h3>
            <p>
              Choose a manual timeline or let matching ready media appear from
              tags.
            </p>
          </div>
          <Field label="Source">
            <Select
              disabled={!canManage}
              value={sourceType}
              onChange={(event) =>
                onSourceTypeChange(event.target.value as "static" | "tag")
              }
            >
              <option value="static">Manual timeline</option>
              <option value="tag">Automatically from media tags</option>
            </Select>
          </Field>

          {sourceType === "tag" && (
            <>
              <Field label="Match">
                <Select
                  disabled={!canManage}
                  value={tagMatch}
                  onChange={(event) =>
                    onTagMatchChange(event.target.value as "any" | "all")
                  }
                >
                  <option value="any">Any selected tag</option>
                  <option value="all">All selected tags</option>
                </Select>
              </Field>
              <div className="field playlist-details-drawer__tags">
                <span className="field__label">Media tags</span>
                <div className="playlist-details-drawer__tag-list">
                  {tags.length ? (
                    tags.map((tag) => {
                      const active = tagIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          className={`playlist-details-drawer__tag${active ? " playlist-details-drawer__tag--active" : ""}`}
                          aria-pressed={active}
                          disabled={!canManage}
                          onClick={() => onTagToggle(tag.id)}
                        >
                          <span
                            className="playlist-details-drawer__tag-dot"
                            style={{ backgroundColor: tag.color }}
                            aria-hidden="true"
                          />
                          {tag.name}
                        </button>
                      );
                    })
                  ) : (
                    <span className="playlist-editor__readout">
                      No tags available
                    </span>
                  )}
                </div>
              </div>
              <Field
                label="Image duration"
                description="Applied to matching image content."
              >
                <div className="playlist-playback__duration-control">
                  <input
                    type="number"
                    min="1"
                    max="86400"
                    disabled={!canManage}
                    value={tagImageSeconds}
                    onChange={(event) =>
                      onTagImageSecondsChange(Number(event.target.value))
                    }
                  />
                  <span>seconds</span>
                </div>
              </Field>
              {tagIds.length === 0 && (
                <p className="playlist-details-drawer__warning">
                  Select at least one tag before saving this source.
                </p>
              )}
            </>
          )}
          {tagRuleError && (
            <div
              className="playlist-editor-notice playlist-editor-notice--error"
              role="alert"
            >
              {tagRuleError}
            </div>
          )}
          <div className="playlist-details-section__actions">
            <Button
              variant="primary"
              compact
              loading={tagRuleSaving}
              disabled={
                !canManage ||
                !tagRuleDirty ||
                (sourceType === "tag" && tagIds.length === 0)
              }
              onClick={onSaveTagRule}
            >
              <Tag size={14} aria-hidden="true" />
              Save content source
            </Button>
          </div>
        </section>
      </div>
    </Drawer>
  );
}
