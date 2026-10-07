import { useTranslation } from "react-i18next";
import type { PlayerCommandType } from "../../api/types";
import { Button } from "../../components/ui/button";
import { BROWSER_COMMANDS } from "./browserCapabilities.gen";

/**
 * The operator commands a Browser Player runs, taken from the generated
 * capability matrix. Nothing here lists a command by name: when the matrix
 * changes, this panel changes with it.
 */
export function BrowserCommandPanel({
  pending,
  onCommand,
}: {
  pending: boolean;
  onCommand: (
    type: PlayerCommandType,
    payload: Record<string, unknown>,
  ) => void;
}) {
  const { t } = useTranslation("screens");
  return (
    <section className="space-y-3" aria-labelledby="browser-commands-heading">
      <div className="space-y-1">
        <h3 id="browser-commands-heading" className="text-sm font-semibold">
          {t("browser.commands.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("browser.commands.body")}
        </p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {BROWSER_COMMANDS.map((command) => (
          <li
            key={command.type}
            className="flex flex-col items-start gap-2 rounded-xl border border-border p-4"
          >
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                onCommand(
                  command.type as PlayerCommandType,
                  command.type === "identify_screen"
                    ? { durationSeconds: 30 }
                    : {},
                )
              }
            >
              {t(`browser.commands.labels.${command.type}` as never)}
            </Button>
            <p className="text-sm text-muted-foreground">
              {t(`browser.commands.details.${command.type}` as never)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
