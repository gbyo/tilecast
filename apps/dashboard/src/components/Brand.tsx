import { TilecastLogo } from "./TilecastLogo";

export function Brand({ compact = false }: { compact?: boolean }) {
  if (compact)
    return (
      <img
        className="brand__studio-logo"
        src="/tilecast-studio-logo.svg"
        alt="Tilecast Studio"
      />
    );
  return (
    <div className="brand">
      <TilecastLogo className="brand__logo" />
    </div>
  );
}
