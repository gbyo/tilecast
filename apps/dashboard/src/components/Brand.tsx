import { TilecastLogo } from "./TilecastLogo";

export function Brand({
  compact = false,
  iconOnlyOnCollapse = false,
}: {
  compact?: boolean;
  iconOnlyOnCollapse?: boolean;
}) {
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
      {iconOnlyOnCollapse ? (
        <span className="brand__mark brand__mark--collapsed" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : null}
      <TilecastLogo
        className={`brand__logo ${iconOnlyOnCollapse ? "brand__logo--expanded" : ""}`.trim()}
      />
    </div>
  );
}
