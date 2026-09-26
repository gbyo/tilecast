/**
 * The completion burst. Pieces are derived from the burst key alone, so every
 * engine draws the same frame for the same countdown.
 */
export const CONFETTI_MS = 11_500;

export interface ConfettiPiece {
  x: string;
  drift: string;
  spin: string;
  delay: string;
  duration: string;
  color: string;
  width: string;
  height: string;
  radius: string;
}

/** Deterministic confetti pieces for a burst key (same on every host). */
export function confettiPieces(key: string): ConfettiPiece[] {
  const colors = ["#F7C948", "#F45B69", "#4CC9F0", "#7BD389", "#A78BFA"];
  let seed = Array.from(key).reduce(
    (value, character) =>
      Math.imul(value ^ character.charCodeAt(0), 16_777_619) >>> 0,
    2_166_136_261,
  );
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  const pieces: ConfettiPiece[] = [];
  for (let index = 0; index < 220; index += 1) {
    pieces.push({
      x: `${random() * 100}%`,
      drift: `${random() * 28 - 14}vw`,
      spin: `${540 + random() * 1_080}deg`,
      delay: `${random() * 3.8}s`,
      duration: `${5 + random() * 2}s`,
      color: colors[index % colors.length] ?? "#F7C948",
      width: `${14 + random() * 14}px`,
      height: `${20 + random() * 20}px`,
      radius: random() > 0.75 ? "50%" : "2px",
    });
  }
  return pieces;
}
