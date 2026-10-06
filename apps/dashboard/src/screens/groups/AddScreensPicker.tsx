import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { api } from "../../api/client";
import type { Screen, ScreenGroup } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { DashboardSearch } from "../../components/DashboardListToolbar";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "../../components/ui/drawer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../components/ui/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toast";
import { screenKeys, screenQueries } from "../../data/screens";
import { useCompactLayout } from "../../hooks/use-compact-layout";
import { screenStatusText } from "./DisplayGroupHealth";
import {
  addScreensInBatch,
  groupPath,
  pickerScreens,
} from "./displayGroupModel";

/**
 * Picks one or more screens to add. A Sheet beside the page on desktop and a
 * Drawer on compact layouts; the body is shared so behavior cannot drift.
 */
export function AddScreensPicker({
  group,
  open,
  onOpenChange,
}: {
  group: ScreenGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const compact = useCompactLayout();
  const title = t("groups.picker.title");
  const description = t("groups.picker.description", { name: group.name });
  // The body resets with each opening: its search, selection, and failures
  // belong to one attempt.
  const body = open ? (
    <PickerBody
      group={group}
      onDone={() => onOpenChange(false)}
      footer={(actions) =>
        compact ? (
          <DrawerFooter className="border-t border-border">
            {actions}
          </DrawerFooter>
        ) : (
          <SheetFooter className="border-t border-border sm:flex-row sm:justify-end">
            {actions}
          </SheetFooter>
        )
      }
    />
  ) : null;

  if (compact)
    return (
      <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
        <DrawerContent aria-label={title} className="max-h-[calc(100dvh-2rem)]">
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>{description}</DrawerDescription>
          </DrawerHeader>
          {body}
        </DrawerContent>
      </Drawer>
    );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        aria-label={title}
        className="gap-0 sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function PickerBody({
  group,
  onDone,
  footer,
}: {
  group: ScreenGroup;
  onDone: () => void;
  footer: (actions: React.ReactNode) => React.ReactNode;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const csrf = useAuth().status?.csrfToken ?? "";
  const client = useQueryClient();
  const inventory = useQuery(screenQueries.list());
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<{ id: string; name: string }[]>([]);

  const memberIds = useMemo(
    () => new Set(group.screens.map((screen) => screen.id)),
    [group.screens],
  );
  const { available, elsewhere } = useMemo(
    () =>
      pickerScreens(inventory.data?.items ?? [], group.id, memberIds, search),
    [inventory.data, group.id, memberIds, search],
  );
  const names = useMemo(
    () =>
      new Map(
        (inventory.data?.items ?? []).map((s) => [s.id, s.name] as const),
      ),
    [inventory.data],
  );

  const add = useMutation({
    mutationFn: (ids: string[]) =>
      addScreensInBatch(ids, (id) => api.addScreenToGroup(group.id, id, csrf)),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ["screen-groups"] });
      await client.invalidateQueries({ queryKey: screenKeys.all });
    },
    onSuccess: (outcome) => {
      setSelected((current) => {
        const next = new Set(current);
        for (const id of outcome.added) next.delete(id);
        return next;
      });
      if (outcome.added.length > 0)
        toast.add({
          title: t("groups.picker.added", { count: outcome.added.length }),
          type: "success",
        });
      if (outcome.failed.length === 0) {
        onDone();
        return;
      }
      setFailures(
        outcome.failed.map(({ id }) => ({ id, name: names.get(id) ?? id })),
      );
    },
    onError: () =>
      toast.add({ title: t("groups.errors.addScreen"), type: "error" }),
  });

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = () => {
    setFailures([]);
    add.mutate([...selected]);
  };

  const actions = (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={add.isPending}
        onClick={onDone}
      >
        {t("common:actions.cancel")}
      </Button>
      <Button
        type="button"
        disabled={selected.size === 0 || add.isPending}
        onClick={submit}
      >
        {add.isPending
          ? t("groups.picker.adding")
          : selected.size === 0
            ? t("groups.picker.addNone")
            : t("groups.picker.add", { count: selected.size })}
      </Button>
    </>
  );

  return (
    <>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 pb-4">
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label={t("groups.picker.searchLabel")}
          placeholder={t("groups.picker.searchPlaceholder")}
          clearLabel={t("groups.search.clearInput")}
          className="max-w-none"
        />

        {failures.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              {t("groups.picker.partialFailure", {
                names: failures.map((failure) => failure.name).join(", "),
              })}
            </AlertDescription>
          </Alert>
        )}

        {inventory.isPending && (
          <div className="grid gap-2" aria-label={t("groups.picker.loading")}>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}
        {inventory.isError && (
          <Alert variant="destructive">
            <AlertDescription>{t("groups.picker.loadError")}</AlertDescription>
          </Alert>
        )}

        {inventory.isSuccess && available.length === 0 && (
          <Empty className="p-6">
            <EmptyHeader>
              <EmptyTitle>
                {search.trim()
                  ? t("groups.picker.noMatchTitle")
                  : t("groups.picker.noneAvailableTitle")}
              </EmptyTitle>
              <EmptyDescription>
                {search.trim()
                  ? t("groups.picker.noMatchDescription")
                  : t("groups.picker.noneAvailableDescription")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {available.length > 0 && (
          <ItemGroup
            aria-label={t("groups.picker.availableLabel")}
            className="gap-1"
          >
            {available.map((screen) => (
              <AvailableRow
                key={screen.id}
                screen={screen}
                checked={selected.has(screen.id)}
                disabled={add.isPending}
                onCheckedChange={(checked) => toggle(screen.id, checked)}
              />
            ))}
          </ItemGroup>
        )}

        {elsewhere.length > 0 && (
          <section className="grid gap-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("groups.picker.elsewhereTitle")}
            </h3>
            <ItemGroup className="gap-1">
              {elsewhere.map((screen) => (
                <ElsewhereRow key={screen.id} screen={screen} />
              ))}
            </ItemGroup>
          </section>
        )}
      </div>
      {footer(actions)}
    </>
  );
}

function AvailableRow({
  screen,
  checked,
  disabled,
  onCheckedChange,
}: {
  screen: Screen;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation("screens");
  return (
    <div role="listitem">
      <Item
        size="sm"
        variant={checked ? "muted" : "default"}
        render={<label />}
        className="cursor-pointer"
      >
        <Checkbox
          aria-label={screen.name}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
        <ItemContent>
          <ItemTitle>{screen.name}</ItemTitle>
          <ItemDescription>
            {screen.location || t("groups.detail.noLocation")} ·{" "}
            {screenStatusText(screen, t)}
          </ItemDescription>
        </ItemContent>
      </Item>
    </div>
  );
}

function ElsewhereRow({ screen }: { screen: Screen }) {
  const { t } = useTranslation("screens");
  return (
    <div role="listitem">
      <Item size="sm" className="opacity-80">
        <Checkbox aria-label={screen.name} checked={false} disabled />
        <ItemContent>
          <ItemTitle>{screen.name}</ItemTitle>
          <ItemDescription>
            {screen.syncGroupName
              ? t("groups.picker.inGroup", { name: screen.syncGroupName })
              : t("groups.picker.inAnotherGroup")}
          </ItemDescription>
        </ItemContent>
        {screen.syncGroupId && (
          <ItemActions>
            <Link
              to={groupPath(screen.syncGroupId)}
              className="text-sm font-medium underline-offset-4 hover:underline"
            >
              {t("groups.picker.viewGroup")}
            </Link>
          </ItemActions>
        )}
      </Item>
    </div>
  );
}
