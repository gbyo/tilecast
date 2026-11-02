import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { contentQueries } from "../../data/content";
import { apiErrorMessage } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import {
  ContentAccessFields,
  type ContentAccessDraft,
} from "./ContentAccessFields";

/**
 * Loads, edits, and saves one account's content access. A failed load never
 * renders as an editable empty policy: saving that would silently take the
 * account's media away.
 */
export function ContentAccessEditor({
  userId,
  csrf,
  disabled,
  roleUsesMedia,
}: {
  userId: string;
  csrf: string;
  disabled?: boolean;
  /** The account's role includes Media or Widgets, so access matters. */
  roleUsesMedia: boolean;
}) {
  const { t } = useTranslation(["account", "common"]);
  const access = useQuery({
    queryKey: ["content-access", userId],
    queryFn: () => api.userContentAccess(userId),
  });
  const owner = access.data?.ownerUnrestricted === true;
  const folders = useQuery({ ...contentQueries.folders(), enabled: !owner });
  const tags = useQuery({ ...contentQueries.tags(), enabled: !owner });
  const [draft, setDraft] = useState<ContentAccessDraft>();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!access.data) return;
    const policy = access.data.policy;
    setDraft({
      libraryMode: policy.libraryMode,
      tagMode: policy.tagMode,
      folderIds: policy.folders.map((folder) => folder.id),
      tagIds: policy.tags.map((tag) => tag.id),
    });
  }, [access.data]);
  const save = useMutation({
    mutationFn: (value: ContentAccessDraft) =>
      api.putUserContentAccess(
        userId,
        {
          libraryMode: value.libraryMode,
          tagMode: value.tagMode,
          folderIds: value.libraryMode === "restricted" ? value.folderIds : [],
          tagIds: value.tagMode === "restricted" ? value.tagIds : [],
        },
        csrf,
      ),
    onSuccess: () => {
      setSaved(true);
      void access.refetch();
    },
  });

  if (owner)
    return (
      <p className="text-sm text-muted-foreground">
        {t("contentAccess.ownerNote")}
      </p>
    );
  const loadError = access.error ?? folders.error ?? tags.error;
  if (loadError)
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {t("contentAccess.loadError")} {apiErrorMessage(loadError)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void access.refetch();
              void folders.refetch();
              void tags.refetch();
            }}
          >
            {t("common:actions.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!draft || !folders.data || !tags.data)
    return (
      <div
        className="grid gap-2"
        role="status"
        aria-label={t("contentAccess.loading")}
      >
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  const restrictedEmpty =
    draft.libraryMode === "restricted" && draft.folderIds.length === 0;
  return (
    <div className="grid gap-4">
      {!roleUsesMedia && (
        <p className="text-sm text-muted-foreground" role="note">
          {t("contentAccess.roleHasNoMedia")}
        </p>
      )}
      {access.data && !access.data.policy.configured && (
        <Alert>
          <AlertDescription>
            {t("contentAccess.notConfigured")}
          </AlertDescription>
        </Alert>
      )}
      <ContentAccessFields
        value={draft}
        onChange={(next) => {
          setSaved(false);
          setDraft(next);
        }}
        folders={folders.data}
        tags={tags.data}
        disabled={disabled}
        idPrefix={`content-access-${userId}`}
      />
      {restrictedEmpty && (
        <p className="text-sm text-muted-foreground" role="note">
          {t("contentAccess.library.emptyNote")}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="status">
          {saved && <span>{t("contentAccess.saved")}</span>}
        </div>
        <Button
          type="button"
          disabled={disabled || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending
            ? t("common:actions.saving")
            : t("contentAccess.saveAction")}
        </Button>
      </div>
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
