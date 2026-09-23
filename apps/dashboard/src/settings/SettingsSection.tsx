import type { SettingDefinition } from "../api/types";
import { dependencyState } from "./settingDependencies";
import { descriptionFor, groupsFor } from "./settingDisplay";
import type { SettingsSectionId } from "./settingsNavigation";
import { SettingControl } from "./SettingControl";

export function SettingsSection({
  section,
  definitions,
  values,
  editable,
  onChange,
  before,
}: {
  section: SettingsSectionId;
  definitions: SettingDefinition[];
  values: Record<string, unknown>;
  editable: boolean;
  onChange: (key: string, value: unknown) => void;
  before?: React.ReactNode;
}) {
  return (
    <div className="grid gap-4">
      {before}
      {groupsFor(section, definitions).map((group) => (
        <section
          className="grid gap-4 rounded-xl border border-border p-4"
          key={group.title}
        >
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">{group.title}</h3>
            {group.description && (
              <p className="text-sm text-muted-foreground">
                {group.description}
              </p>
            )}
          </header>
          {group.definitions.map((definition) => {
            const dependency = dependencyState(definition.key, values);
            const disabled = !editable || dependency.disabled;
            return (
              <div
                className="grid gap-3 has-[:disabled]:opacity-60 sm:grid-cols-2"
                key={definition.key}
              >
                <div className="grid content-start gap-1">
                  <label className="text-sm font-medium">
                    {definition.title}
                  </label>
                  <p className="text-sm text-muted-foreground">
                    {descriptionFor(definition)}
                  </p>
                  {definition.futureOnly && (
                    <span className="text-xs text-muted-foreground">
                      Applies to future processing only
                    </span>
                  )}
                  {dependency.disabled && (
                    <span className="text-xs text-muted-foreground">
                      {dependency.message}
                    </span>
                  )}
                </div>
                <div className="grid content-start gap-2">
                  <SettingControl
                    definition={definition}
                    value={values[definition.key] ?? definition.default}
                    disabled={disabled}
                    onChange={(value) => onChange(definition.key, value)}
                  />
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
