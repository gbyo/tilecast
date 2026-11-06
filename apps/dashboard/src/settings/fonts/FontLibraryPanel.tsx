import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CloudDownload, Trash2, Type, Upload } from "lucide-react";
import { deleteFont } from "../../api/fonts";
import type { FontFamily } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { useConfirm } from "../../components/ConfirmDialog";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import { Spinner } from "../../components/ui/spinner";
import { toast } from "../../components/ui/toast";
import { fontKeys } from "../../data/fonts";
import { libraryFamilyName, useLibraryFonts } from "../../fonts/libraryFonts";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { formatBytes } from "../../lib/formatBytes";
import { GoogleFontDialog } from "./GoogleFontDialog";
import { UploadFontDialog } from "./UploadFontDialog";

/**
 * The organization font library: families copied from Google Fonts or
 * uploaded. A role that can read screens or manage settings can see it;
 * settings.manage can change it. Players receive a family only when a published Layout uses it.
 */
export function FontLibraryPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const client = useQueryClient();
  const locale = useFormatLocale();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const library = useLibraryFonts();
  const [dialog, setDialog] = useState<"google" | "upload">();
  const [notice, setNotice] = useState<string>();
  const remove = useMutation({
    mutationFn: (family: FontFamily) =>
      deleteFont(family.id, auth.status?.csrfToken ?? ""),
    onSuccess: async (_, family) => {
      setNotice(undefined);
      toast.add({
        title: t("fonts.deleted", { family: family.family }),
        type: "success",
      });
      await client.invalidateQueries({ queryKey: fontKeys.library });
    },
    onError: (error) => setNotice(apiErrorMessage(error)),
  });
  const added = (family: FontFamily) => {
    setDialog(undefined);
    toast.add({
      title: t("fonts.added", { family: family.family }),
      type: "success",
    });
  };
  return (
    <>
      {confirmDialog}
      <section className="grid gap-4">
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="default" onClick={() => setDialog("google")}>
              <CloudDownload size={16} aria-hidden="true" />
              {t("fonts.addGoogle")}
            </Button>
            <Button variant="outline" onClick={() => setDialog("upload")}>
              <Upload size={16} aria-hidden="true" />
              {t("fonts.upload")}
            </Button>
          </div>
        )}
        {notice && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {library.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {apiErrorMessage(library.error)}
            </AlertDescription>
          </Alert>
        )}
        {library.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            {t("fonts.loading")}
          </p>
        ) : library.families.length === 0 && !library.isError ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Type size={24} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t("fonts.empty")}</EmptyTitle>
              <EmptyDescription>{t("fonts.emptyHint")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {library.families.map((family) => (
              <Item key={family.id} variant="outline">
                <ItemMedia
                  variant="icon"
                  className="size-10 rounded-lg bg-muted text-lg"
                  style={{
                    fontFamily: `"${libraryFamilyName(family.id)}", var(--font-sans)`,
                  }}
                  aria-hidden="true"
                >
                  {/* i18n-ignore: a decorative type specimen, hidden from assistive technology */}
                  Aa
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {family.family}
                    <Badge variant="secondary">
                      {family.source === "google"
                        ? t("fonts.sourceGoogle")
                        : t("fonts.sourceUpload")}
                    </Badge>
                  </ItemTitle>
                  <p
                    className="truncate text-base"
                    style={{
                      fontFamily: `"${libraryFamilyName(family.id)}", var(--font-sans)`,
                    }}
                  >
                    {t("fonts.sample")}
                  </p>
                  <ItemDescription>
                    {[
                      family.license || t("fonts.licenseAttested"),
                      t("fonts.files", { count: family.faces.length }),
                      formatBytes(family.totalBytes, locale),
                      family.subsets.length
                        ? family.subsets.join(", ")
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </ItemDescription>
                </ItemContent>
                {canManage && (
                  <ItemActions>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("fonts.deleteFamily", {
                        family: family.family,
                      })}
                      disabled={remove.isPending}
                      onClick={() =>
                        void confirm({
                          title: t("fonts.deleteTitle", {
                            family: family.family,
                          }),
                          body: t("fonts.deleteDescription"),
                          action: t("common:actions.delete"),
                          destructive: true,
                        }).then((ok) => {
                          if (ok) remove.mutate(family);
                        })
                      }
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </ItemActions>
                )}
              </Item>
            ))}
          </ItemGroup>
        )}
        <p className="max-w-[760px] text-sm text-muted-foreground">
          {t("fonts.offlineNote")}
        </p>
      </section>
      {dialog === "google" && (
        <GoogleFontDialog
          onClose={() => setDialog(undefined)}
          onAdded={added}
        />
      )}
      {dialog === "upload" && (
        <UploadFontDialog
          onClose={() => setDialog(undefined)}
          onUploaded={async () => {
            await client.invalidateQueries({ queryKey: fontKeys.library });
          }}
        />
      )}
    </>
  );
}
