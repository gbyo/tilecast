import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Field, FieldLabel } from "../components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../components/ui/sidebar";
import {
  settingsNavigation,
  sectionDetails,
  type SettingsSectionId,
} from "./settingsNavigation";

export function SettingsShell({
  active,
  dirty,
  onNavigate,
  children,
}: {
  active: SettingsSectionId;
  dirty: Set<SettingsSectionId>;
  onNavigate: (next: SettingsSectionId) => boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const details = sectionDetails[active];
  const items = settingsNavigation.flatMap((group) => group.items);
  const activeItem = items.find((item) => item.id === active);
  return (
    <div className="mx-auto grid max-w-[1240px] grid-cols-[208px_minmax(0,1fr)] items-start gap-8 max-[1050px]:grid-cols-[190px_minmax(0,1fr)] max-[1050px]:gap-[22px] max-[850px]:grid-cols-1">
      <div>
        <Field className="hidden max-[850px]:grid max-[850px]:gap-1">
          <FieldLabel htmlFor="settings-mobile-section">
            {t("shell.sectionLabel")}
          </FieldLabel>
          <Select
            items={items.map((item) => ({
              value: item.id,
              label: `${t(item.labelKey)}${dirty.has(item.id) ? t("shell.unsavedSuffix") : ""}`,
            }))}
            value={active}
            onValueChange={(value) => {
              const item = items.find((candidate) => candidate.id === value);
              if (item && onNavigate(item.id))
                void navigate(`/settings/${item.path}`);
            }}
          >
            <SelectTrigger id="settings-mobile-section" className="w-full">
              <SelectValue>
                {activeItem ? t(activeItem.labelKey) : ""}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {t(item.labelKey)}
                  {dirty.has(item.id) ? t("shell.unsavedSuffix") : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <nav
          aria-label={t("shell.sectionsLabel")}
          className="max-[850px]:hidden"
        >
          {/* A column on the content surface, not a second chrome panel. */}
          <Sidebar collapsible="none" className="h-auto w-full bg-transparent">
            <SidebarContent>
              {settingsNavigation.map((group) => (
                <SidebarGroup key={group.labelKey}>
                  <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.items.map((item) => {
                        const Icon = sectionDetails[item.id].icon;
                        const isActive = active === item.id;
                        const isDirty = dirty.has(item.id);
                        const badgeId = `settings-nav-unsaved-${item.id}`;
                        return (
                          <SidebarMenuItem key={item.id}>
                            <SidebarMenuButton
                              isActive={isActive}
                              // Room for the widest translated badge, so a
                              // long label truncates instead of running under it.
                              className={isDirty ? "pr-24" : undefined}
                              render={
                                <Link
                                  to={`/settings/${item.path}`}
                                  aria-current={isActive ? "page" : undefined}
                                  aria-describedby={
                                    isDirty ? badgeId : undefined
                                  }
                                  onClick={(event) => {
                                    if (!onNavigate(item.id))
                                      event.preventDefault();
                                  }}
                                />
                              }
                            >
                              <Icon aria-hidden="true" />
                              <span>{t(item.labelKey)}</span>
                            </SidebarMenuButton>
                            {isDirty && (
                              <SidebarMenuBadge id={badgeId}>
                                {t("shell.unsavedBadge")}
                              </SidebarMenuBadge>
                            )}
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </SidebarContent>
          </Sidebar>
        </nav>
      </div>
      <main className="min-w-0 pb-[88px]">
        <header className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 border-b border-border pb-[18px] max-[850px]:mt-[18px]">
          <span className="grid size-[38px] place-items-center rounded-md bg-primary/10 row-span-2 text-primary">
            <details.icon size={20} aria-hidden="true" />
          </span>
          <h1 className="col-start-2 text-[25px] leading-[1.2] max-[600px]:text-[22px]">
            {t(details.titleKey)}
          </h1>
          <p className="col-start-2 mt-1.5 max-w-[760px] text-sm text-muted-foreground">
            {t(details.descriptionKey)}
          </p>
        </header>
        {children}
      </main>
    </div>
  );
}
