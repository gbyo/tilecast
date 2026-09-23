import { TilecastLogo } from "./TilecastLogo";
import { TilecastStudioLogo } from "./TilecastStudioLogo";

export function Brand({ compact = false }: { compact?: boolean }) {
  if (compact)
    return (
      <TilecastStudioLogo className="brand__studio-logo text-foreground" />
    );
  return (
    <div className="brand">
      <TilecastLogo className="brand__logo" />
    </div>
  );
}
