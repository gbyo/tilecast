import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import type { PackageCapabilities } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import { Skeleton } from "../../components/ui/skeleton";
import { CapabilityItem, ContributionItem } from "./CapabilityItems";
import {
  capabilityRows,
  type ContributionRow,
  type PluginDetailViewModel,
} from "./detailView";

/** A readable page section: an h2 and its content, no surrounding card. */
export function DetailSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <div className="grid gap-0.5">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Pending({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

/**
 * What the plugin is, in its own words: the listing's long description when
 * it has one, and the short description otherwise. Where it comes from is
 * the sidebar card's job. Plain text only, so a description can never carry
 * markup into Studio.
 */
export function AboutSection({ view }: { view: PluginDetailViewModel }) {
  const { t } = useTranslation("plugins");
  const attention = view.plugin?.attention ?? [];
  const text = (view.longDescription || view.description).trim();
  const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim() !== "");
  if (paragraphs.length === 0 && attention.length === 0) return null;
  return (
    <DetailSection id="detail-about" title={t("storeDetail.about.title")}>
      <div className="grid max-w-prose gap-3">
        {paragraphs.map((paragraph) => (
          <p
            key={paragraph}
            className="text-sm/relaxed whitespace-pre-line text-muted-foreground"
          >
            {paragraph}
          </p>
        ))}
      </div>
      {attention.map((note) => (
        <Alert key={note.code}>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{note.message}</AlertDescription>
        </Alert>
      ))}
    </DetailSection>
  );
}

/**
 * What the package adds to Studio. An uninstalled external package states
 * this only in its install review, because the listing names no
 * contributions; the page says so instead of guessing.
 */
export function ContributionsSection({
  view,
  contributions,
  loading,
}: {
  view: PluginDetailViewModel;
  /** Null when this installation has not seen the package manifest yet. */
  contributions: ContributionRow[] | null;
  loading: boolean;
}) {
  const { t } = useTranslation("plugins");
  if (view.sourceKind === "included") return null;
  return (
    <DetailSection id="detail-adds" title={t("storeDetail.adds.title")}>
      {loading ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : contributions === null ? (
        <Pending>{t("storeDetail.adds.pending")}</Pending>
      ) : contributions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("storeDetail.adds.none")}
        </p>
      ) : (
        <ItemGroup render={<ul />} className="gap-2">
          {contributions.map((row) => (
            <ContributionItem key={row.key} row={row} />
          ))}
        </ItemGroup>
      )}
    </DetailSection>
  );
}

/**
 * The capabilities a package requests, as sentences. Included plugins list
 * the behaviors their release already declares; external packages list the
 * reviewed manifest capabilities once this installation has seen them.
 */
export function CapabilitiesSection({
  view,
  capabilities,
  loading,
}: {
  view: PluginDetailViewModel;
  /** Null when this installation has not seen the package manifest yet. */
  capabilities: PackageCapabilities | undefined | null;
  loading: boolean;
}) {
  const { t } = useTranslation("plugins");
  const included = view.plugin?.capabilities ?? [];
  const rows = capabilities ? capabilityRows(capabilities) : [];
  return (
    <DetailSection
      id="detail-permissions"
      title={t("storeDetail.permissions.title")}
    >
      {loading ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : view.sourceKind === "included" ? (
        included.length === 0 ? (
          <NoSpecialPermissions />
        ) : (
          <ItemGroup render={<ul />} className="gap-2">
            {included.map((capability) => (
              <Item key={capability} variant="muted" size="sm" render={<li />}>
                <ItemMedia variant="icon">
                  <CircleCheck aria-hidden="true" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{capability}</ItemTitle>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        )
      ) : capabilities === null ? (
        <Pending>{t("storeDetail.permissions.pending")}</Pending>
      ) : rows.length === 0 ? (
        <NoSpecialPermissions />
      ) : (
        <ItemGroup render={<ul />} className="gap-2">
          {rows.map((row) => (
            <CapabilityItem key={row.kind} row={row} />
          ))}
        </ItemGroup>
      )}
    </DetailSection>
  );
}

function NoSpecialPermissions() {
  const { t } = useTranslation("plugins");
  return (
    <div className="grid gap-0.5 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <CircleCheck className="size-4" aria-hidden="true" />
        {t("storeDetail.permissions.noneTitle")}
      </p>
      <p className="text-muted-foreground">
        {t("storeDetail.permissions.noneBody")}
      </p>
    </div>
  );
}

/**
 * What an included plugin needs from the installation. External packages
 * have one requirement, the Tilecast release, and the package status card
 * and the compatibility notice already carry it, so the section appears only
 * when there is something to say beyond that.
 */
export function RequirementsSection({ view }: { view: PluginDetailViewModel }) {
  const { t } = useTranslation("plugins");
  const requirements = view.plugin?.requirements ?? [];
  if (requirements.length === 0) return null;
  return (
    <DetailSection
      id="detail-requirements"
      title={t("storeDetail.requirements.title")}
    >
      <ItemGroup render={<ul />} className="gap-2">
        {requirements.map((requirement) => (
          <Item
            key={requirement.kind + requirement.label}
            variant="muted"
            size="sm"
            render={<li />}
          >
            <ItemMedia variant="icon">
              <CircleCheck aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{requirement.label}</ItemTitle>
              {requirement.description && (
                <ItemDescription className="line-clamp-none">
                  {requirement.description}
                </ItemDescription>
              )}
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </DetailSection>
  );
}
