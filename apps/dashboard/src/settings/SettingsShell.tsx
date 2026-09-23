import { Link, useNavigate } from "react-router";
import { Field, FieldLabel } from "../components/ui/field";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
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
  const navigate = useNavigate();
  const details = sectionDetails[active];
  const items = settingsNavigation.flatMap((group) => group.items);
  const activeLabel = items.find((item) => item.id === active)?.label ?? "";
  return (
    <div className="mx-auto grid max-w-[1240px] grid-cols-[208px_minmax(0,1fr)] items-start gap-8 max-[1050px]:grid-cols-[190px_minmax(0,1fr)] max-[1050px]:gap-[22px] max-[850px]:grid-cols-1">
      <aside
        className="sticky top-[72px] grid max-h-[calc(100vh-90px)] gap-[17px] overflow-y-auto py-0.5 pr-1 max-[850px]:static max-[850px]:max-h-none max-[850px]:p-0"
        aria-label="Settings sections"
      >
        <Field className="hidden max-[850px]:grid max-[850px]:gap-1">
          <FieldLabel htmlFor="settings-mobile-section">
            Settings section
          </FieldLabel>
          <RheaSelect
            value={active}
            onValueChange={(value) => {
              const item = items.find((candidate) => candidate.id === value);
              if (item && onNavigate(item.id))
                void navigate(`/settings/${item.path}`);
            }}
          >
            <SelectTrigger id="settings-mobile-section" className="w-full">
              <SelectValue>{activeLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                  {dirty.has(item.id) ? " • Unsaved" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </RheaSelect>
        </Field>
        {settingsNavigation.map((group) => (
          <div className="grid gap-0.5 max-[850px]:hidden" key={group.label}>
            <h2 className="mb-1 px-2.5 text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
              {group.label}
            </h2>
            {group.items.map((item) => {
              const Icon = sectionDetails[item.id].icon;
              const isActive = active === item.id;
              return (
                <Link
                  key={item.id}
                  to={`/settings/${item.path}`}
                  aria-current={isActive ? "page" : undefined}
                  onClick={(event) => {
                    if (!onNavigate(item.id)) event.preventDefault();
                  }}
                  className="flex min-h-9 items-center gap-2 border-l-[3px] border-transparent px-2.5 py-[7px] text-sm text-muted-foreground no-underline hover:bg-muted hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:bg-primary/10 aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
                >
                  <Icon size={16} aria-hidden="true" className="shrink-0" />
                  <span className="mr-auto">{item.label}</span>
                  {dirty.has(item.id) && (
                    <small className="text-[10px] text-amber-600">
                      Unsaved
                    </small>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </aside>
      <main className="min-w-0 pb-[88px]">
        <header className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 border-b border-border pb-[18px] max-[850px]:mt-[18px]">
          <span className="grid size-[38px] place-items-center rounded-md bg-primary/10 row-span-2 text-primary">
            <details.icon size={20} aria-hidden="true" />
          </span>
          <h1 className="col-start-2 text-[25px] leading-[1.2] max-[600px]:text-[22px]">
            {details.title}
          </h1>
          <p className="col-start-2 mt-1.5 max-w-[760px] text-sm text-muted-foreground">
            {details.description}
          </p>
        </header>
        {children}
      </main>
    </div>
  );
}
