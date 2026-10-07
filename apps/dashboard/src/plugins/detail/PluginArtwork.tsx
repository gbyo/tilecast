import { useState } from "react";
import { Puzzle } from "lucide-react";
import { cn } from "cn";
import { PluginIcon } from "../PluginIcon";

/**
 * The plugin's mark at hero size. Included plugins use the icon Studio
 * ships; marketplace artwork loads from the server's own path and gives way
 * to the generic icon on any failure, so a broken image never leaves a hole.
 * Custom packages have no artwork of their own and show the generic icon.
 */
export function PluginArtwork({
  pluginId,
  iconUrl,
  className,
  glyphClassName = "size-8",
}: {
  pluginId?: string;
  iconUrl?: string;
  className?: string;
  glyphClassName?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const artwork = iconUrl && iconUrl !== failedUrl ? iconUrl : null;
  return (
    <div
      data-slot="plugin-artwork"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted text-muted-foreground ring-1 ring-foreground/10",
        className,
      )}
    >
      {pluginId ? (
        <PluginIcon pluginId={pluginId} className={glyphClassName} />
      ) : artwork ? (
        <img
          src={artwork}
          alt=""
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setFailedUrl(artwork)}
        />
      ) : (
        <Puzzle className={glyphClassName} aria-hidden="true" />
      )}
    </div>
  );
}
