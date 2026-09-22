import { Select } from "../components/ui";
import { Link, useNavigate } from "react-router";
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
  onNavigate: (next: SettingsSectionId) => boolean | Promise<boolean>;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const details = sectionDetails[active];
  const requestNavigate = async (id: SettingsSectionId) => {
    const item = settingsNavigation
      .flatMap((group) => group.items)
      .find((candidate) => candidate.id === id);
    if (item && await onNavigate(item.id)) {
      void navigate(`/settings/${item.path}`);
    }
  };
  return (
    <div className="settings-layout">
      <aside className="settings-nav" aria-label="Settings sections">
        <label className="settings-mobile-select">
          <span>Settings section</span>
          <Select
            value={active}
            onChange={(event) => {
              const item = settingsNavigation
                .flatMap((group) => group.items)
                .find((item) => item.id === event.target.value);
              if (item) void requestNavigate(item.id);
            }}
          >
            {settingsNavigation
              .flatMap((group) => group.items)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {dirty.has(item.id) ? " • Unsaved" : ""}
                </option>
              ))}
          </Select>
        </label>
        {settingsNavigation.map((group) => (
          <div className="settings-nav-group" key={group.label}>
            <h2>{group.label}</h2>
            {group.items.map((item) => {
              const Icon = sectionDetails[item.id].icon;
              return (
                <Link
                  key={item.id}
                  to={`/settings/${item.path}`}
                  aria-current={active === item.id ? "page" : undefined}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    if (active !== item.id) void requestNavigate(item.id);
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{item.label}</span>
                  {dirty.has(item.id) && <small>Unsaved</small>}
                </Link>
              );
            })}
          </div>
        ))}
      </aside>
      <main className="settings-content">
        <header className="settings-heading">
          <span className="settings-heading__icon">
            <details.icon size={20} aria-hidden="true" />
          </span>
          <h1>{details.title}</h1>
          <p>{details.description}</p>
        </header>
        {children}
      </main>
    </div>
  );
}
