/**
 * Shared geometry for the Overview's cards, so every header, action, and
 * list row lines up on one set of edges. All of it keys off the Card's own
 * `--card-spacing` token, so a card's padding and its full-bleed rows cannot
 * drift apart.
 */

/** A card or rail title, centered in the same 24px row as its header action. */
export const titleRow =
  "flex min-h-6 items-center font-heading text-sm leading-normal font-medium max-sm:min-h-10";

/**
 * A title beside a 32px control, such as the uptime range toggle, so cards
 * that share a top edge also share a title line.
 */
export const tallTitleRow = `${titleRow} min-h-8`;

/**
 * A quiet text action in a header, used with the `xs` button size. The
 * negative margin lines its label up with the content edge and the row
 * chevrons instead of its invisible box.
 */
export const headerAction = "-mr-1.5 max-sm:h-10";

/** A list that runs edge to edge inside a card, so hover and rules span it. */
export const listBleed = "-mx-(--card-spacing) w-auto gap-0";

/**
 * One dense row: 44px tall, text on the card's content edge. The border is
 * removed so the padding alone sets the edge.
 */
export const rowBleed =
  "relative min-h-11 rounded-none border-0 px-(--card-spacing) py-1";
