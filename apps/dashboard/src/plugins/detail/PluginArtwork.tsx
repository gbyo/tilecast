import { useState } from "react";
import { Puzzle } from "lucide-react";
import { cn } from "cn";
import { PluginIcon } from "../PluginIcon";

/**
 * The plugin's mark at hero size. Store artwork, whether an included
 * plugin's or a marketplace listing's, loads from the server's own path.
 * On any failure, or without artwork, an included plugin shows the glyph
 * Studio ships and every other entry shows the generic icon, so a broken
 * image never leaves a hole.
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
      {artwork ? (
        <img
          src={artwork}
          alt=""
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setFailedUrl(artwork)}
        />
      ) : pluginId ? (
        <PluginIcon pluginId={pluginId} className={glyphClassName} />
      ) : (
        <Puzzle className={glyphClassName} aria-hidden="true" />
      )}
    </div>
  );
}
