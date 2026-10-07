import { browserSupportsCommand } from "./browser/browserCapabilities.gen";
import { screenPlatformFamily } from "../playerPlatform";

/**
 * The one place Studio decides whether a command makes sense for a Screen.
 *
 * A Browser Player runs only the command types in its generated capability
 * matrix (`apps/player-web/capabilities.json`), and the server refuses the
 * rest. Every other Player accepts every type the server defines and answers
 * `unsupported_command` for one it cannot run. Controls ask this function.
 * They never test a platform name themselves.
 */
export function screenSupportsCommand(
  screen: { platform: string; playerFamily?: string },
  commandType: string,
): boolean {
  return screenRunsBrowserPlayer(screen)
    ? browserSupportsCommand(commandType)
    : true;
}

export function screenRunsBrowserPlayer(screen: {
  platform: string;
  playerFamily?: string;
}): boolean {
  return (
    screenPlatformFamily(screen.platform) === "browser" ||
    screen.playerFamily === "browser"
  );
}
