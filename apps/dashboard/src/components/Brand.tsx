import { style } from "@react-spectrum/s2/style" with { type: "macro" };

const brandStyles = style({
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "neutral",
});

const markStyles = style({
  display: "grid",
  gridTemplateColumns: "repeat(2, 9px)",
  gridTemplateRows: "repeat(2, 9px)",
  gap: 2,
  width: 20,
  height: 20,
  flexShrink: 0,
  transform: "rotate(1deg)",
});

const amberMarkStyles = style({
  gridRow: "span 2",
  backgroundColor: "orange-800",
  borderRadius: "sm",
});

const blueMarkStyles = style({
  backgroundColor: "blue-800",
  borderRadius: "sm",
});

const neutralMarkStyles = style({
  backgroundColor: "gray-500",
  borderRadius: "sm",
});

const nameStyles = style({
  font: "heading-sm",
  fontWeight: "bold",
  letterSpacing: "[-0.04em]",
});

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={brandStyles} aria-label={compact ? "Tilecast Studio" : "Tilecast"}>
      <span className={markStyles} aria-hidden="true">
        <span className={amberMarkStyles} />
        <span className={blueMarkStyles} />
        <span className={neutralMarkStyles} />
      </span>
      <span className={nameStyles}>{compact ? "Tilecast Studio" : "Tilecast"}</span>
    </div>
  );
}
