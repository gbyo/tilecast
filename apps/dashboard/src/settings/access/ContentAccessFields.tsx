import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderClosed, Tag } from "lucide-react";
import type {
  ContentAccessMode,
  ContentFolder,
  ContentTag,
} from "../../api/types";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";

export type ContentAccessDraft = {
  libraryMode: ContentAccessMode;
  tagMode: ContentAccessMode;
  folderIds: string[];
  tagIds: string[];
};

type FolderRow = { folder: ContentFolder; depth: number; path: string[] };

/**
 * Folders in tree order with their depth. A folder whose parent is not in the
 * list (because the signed-in account cannot see it) starts a tree of its own.
 */
export function folderTree(folders: readonly ContentFolder[]): FolderRow[] {
  const ids = new Set(folders.map((folder) => folder.id));
  const children = new Map<string, ContentFolder[]>();
  const roots: ContentFolder[] = [];
  for (const folder of folders) {
    if (folder.parentId && ids.has(folder.parentId)) {
      const siblings = children.get(folder.parentId) ?? [];
      siblings.push(folder);
      children.set(folder.parentId, siblings);
    } else {
      roots.push(folder);
    }
  }
  const byName = (left: ContentFolder, right: ContentFolder) =>
    left.name.localeCompare(right.name);
  const rows: FolderRow[] = [];
  const visit = (folder: ContentFolder, depth: number, path: string[]) => {
    const here = [...path, folder.name];
    rows.push({ folder, depth, path: here });
    (children.get(folder.id) ?? []).sort(byName).forEach((child) => {
      visit(child, depth + 1, here);
    });
  };
  roots.sort(byName).forEach((root) => visit(root, 0, []));
  return rows;
}

/** The folders a grant on each id also covers. */
function coveredByAncestor(
  rows: readonly FolderRow[],
  granted: ReadonlySet<string>,
): Set<string> {
  const parentOf = new Map(
    rows.map((row) => [row.folder.id, row.folder.parentId]),
  );
  const covered = new Set<string>();
  for (const row of rows) {
    let parent = parentOf.get(row.folder.id);
    while (parent) {
      if (granted.has(parent)) {
        covered.add(row.folder.id);
        break;
      }
      parent = parentOf.get(parent);
    }
  }
  return covered;
}

/**
 * The Media library part of an account: which folders it reaches and which
 * tags it may apply. Tags never make media visible; they are labels this
 * account may add or remove on media it can already reach.
 */
export function ContentAccessFields({
  value,
  onChange,
  folders,
  tags,
  disabled,
  idPrefix,
}: {
  value: ContentAccessDraft;
  onChange: (next: ContentAccessDraft) => void;
  folders: readonly ContentFolder[];
  tags: readonly ContentTag[];
  disabled?: boolean;
  idPrefix: string;
}) {
  const { t } = useTranslation("account");
  const [search, setSearch] = useState("");
  const rows = useMemo(() => folderTree(folders), [folders]);
  const granted = useMemo(() => new Set(value.folderIds), [value.folderIds]);
  const covered = useMemo(
    () => coveredByAncestor(rows, granted),
    [rows, granted],
  );
  const query = search.trim().toLowerCase();
  const visibleRows = query
    ? rows.filter((row) => row.path.join(" / ").toLowerCase().includes(query))
    : rows;
  const selectedTags = new Set(value.tagIds);
  const set = (patch: Partial<ContentAccessDraft>) =>
    onChange({ ...value, ...patch });

  return (
    <div className="grid gap-5">
      <FieldSet>
        <FieldLegend>{t("contentAccess.library.legend")}</FieldLegend>
        <FieldDescription>
          {t("contentAccess.library.description")}
        </FieldDescription>
        <RadioGroup
          value={value.libraryMode}
          onValueChange={(mode) =>
            set({ libraryMode: mode as ContentAccessMode })
          }
          className="grid gap-3"
        >
          <Field orientation="horizontal" className="items-start gap-3">
            <RadioGroupItem
              value="all"
              id={`${idPrefix}-library-all`}
              disabled={disabled}
            />
            <div className="grid gap-1">
              <FieldLabel htmlFor={`${idPrefix}-library-all`}>
                {t("contentAccess.library.all")}
              </FieldLabel>
              <p className="text-sm text-muted-foreground">
                {t("contentAccess.library.allHint")}
              </p>
            </div>
          </Field>
          <Field orientation="horizontal" className="items-start gap-3">
            <RadioGroupItem
              value="restricted"
              id={`${idPrefix}-library-restricted`}
              disabled={disabled}
            />
            <div className="grid gap-1">
              <FieldLabel htmlFor={`${idPrefix}-library-restricted`}>
                {t("contentAccess.library.restricted")}
              </FieldLabel>
              <p className="text-sm text-muted-foreground">
                {t("contentAccess.library.restrictedHint", {
                  count: value.folderIds.length,
                })}
              </p>
            </div>
          </Field>
        </RadioGroup>
        {value.libraryMode === "restricted" && (
          <div className="grid gap-2 rounded-lg border border-border p-3">
            {rows.length > 8 && (
              <Field>
                <FieldLabel
                  htmlFor={`${idPrefix}-folder-search`}
                  className="sr-only"
                >
                  {t("contentAccess.library.searchLabel")}
                </FieldLabel>
                <Input
                  id={`${idPrefix}-folder-search`}
                  type="search"
                  value={search}
                  placeholder={t("contentAccess.library.searchPlaceholder")}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </Field>
            )}
            {!rows.length ? (
              <p className="text-sm text-muted-foreground">
                {t("contentAccess.library.noFolders")}
              </p>
            ) : !visibleRows.length ? (
              <p className="text-sm text-muted-foreground">
                {t("contentAccess.library.noMatch")}
              </p>
            ) : (
              <ul className="grid max-h-64 gap-1 overflow-y-auto" role="list">
                {visibleRows.map((row) => {
                  const id = `${idPrefix}-folder-${row.folder.id}`;
                  const inherited = covered.has(row.folder.id);
                  return (
                    <li key={row.folder.id}>
                      <Field
                        orientation="horizontal"
                        className="items-center"
                        data-disabled={disabled || inherited}
                        style={{
                          paddingInlineStart: query ? 0 : row.depth * 20,
                        }}
                      >
                        <Checkbox
                          id={id}
                          disabled={disabled || inherited}
                          checked={granted.has(row.folder.id) || inherited}
                          onCheckedChange={(checked) =>
                            set({
                              folderIds:
                                checked === true
                                  ? [...value.folderIds, row.folder.id]
                                  : value.folderIds.filter(
                                      (folder) => folder !== row.folder.id,
                                    ),
                            })
                          }
                        />
                        <FieldLabel
                          htmlFor={id}
                          className="gap-1.5 font-normal"
                        >
                          <FolderClosed size={14} aria-hidden="true" />
                          {query ? row.path.join(" / ") : row.folder.name}
                          {inherited && (
                            <span className="text-xs text-muted-foreground">
                              {t("contentAccess.library.included")}
                            </span>
                          )}
                        </FieldLabel>
                      </Field>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              {t("contentAccess.library.subtreeNote")}
            </p>
          </div>
        )}
      </FieldSet>

      <FieldSet>
        <FieldLegend>{t("contentAccess.tags.legend")}</FieldLegend>
        <FieldDescription>
          {t("contentAccess.tags.description")}
        </FieldDescription>
        <RadioGroup
          value={value.tagMode}
          onValueChange={(mode) => set({ tagMode: mode as ContentAccessMode })}
          className="grid gap-3"
        >
          <Field orientation="horizontal" className="items-start gap-3">
            <RadioGroupItem
              value="all"
              id={`${idPrefix}-tags-all`}
              disabled={disabled}
            />
            <FieldLabel htmlFor={`${idPrefix}-tags-all`}>
              {t("contentAccess.tags.all")}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal" className="items-start gap-3">
            <RadioGroupItem
              value="restricted"
              id={`${idPrefix}-tags-restricted`}
              disabled={disabled}
            />
            <div className="grid gap-1">
              <FieldLabel htmlFor={`${idPrefix}-tags-restricted`}>
                {t("contentAccess.tags.restricted")}
              </FieldLabel>
              <p className="text-sm text-muted-foreground">
                {t("contentAccess.tags.restrictedHint", {
                  count: value.tagIds.length,
                })}
              </p>
            </div>
          </Field>
        </RadioGroup>
        {value.tagMode === "restricted" && (
          <div className="grid gap-1 rounded-lg border border-border p-3">
            {!tags.length ? (
              <p className="text-sm text-muted-foreground">
                {t("contentAccess.tags.noTags")}
              </p>
            ) : (
              <ul className="grid max-h-48 gap-1 overflow-y-auto" role="list">
                {tags.map((tag) => {
                  const id = `${idPrefix}-tag-${tag.id}`;
                  return (
                    <li key={tag.id}>
                      <Field
                        orientation="horizontal"
                        className="items-center"
                        data-disabled={disabled}
                      >
                        <Checkbox
                          id={id}
                          disabled={disabled}
                          checked={selectedTags.has(tag.id)}
                          onCheckedChange={(checked) =>
                            set({
                              tagIds:
                                checked === true
                                  ? [...value.tagIds, tag.id]
                                  : value.tagIds.filter(
                                      (item) => item !== tag.id,
                                    ),
                            })
                          }
                        />
                        <FieldLabel
                          htmlFor={id}
                          className="gap-1.5 font-normal"
                        >
                          <Tag
                            size={14}
                            aria-hidden="true"
                            style={{ color: tag.color }}
                          />
                          {tag.name}
                        </FieldLabel>
                      </Field>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </FieldSet>
    </div>
  );
}
