/**
 * Shared Website failure presentation for every remote web surface
 * (`host-view` and the legacy Electron adapter): the Tilecast
 * "Website unavailable" placeholder and the fallback image. Failure policy
 * itself (which of these shows, and what the machine does) lives in each
 * surface's `fail`, next to its content lifecycle; this module only renders,
 * in the runtime's own visual language.
 */

/** Show the Tilecast "Website unavailable" placeholder in `element`. */
export function showWebsitePlaceholder(element: HTMLElement): void {
  element.replaceChildren();
  const box = document.createElement("div");
  box.className = "tc-website-placeholder";
  box.setAttribute("role", "status");
  box.setAttribute("aria-label", "Website unavailable");
  const message = document.createElement("p");
  message.className = "tc-website-placeholder__message";
  message.textContent = "Website unavailable";
  box.appendChild(message);
  element.appendChild(box);
}

/**
 * Show the fallback image in `element`. The caller settles on load or
 * error: a promised fallback that cannot be shown must fail deterministically
 * rather than hang.
 */
export function showFallbackImage(
  element: HTMLElement,
  src: string,
): HTMLImageElement {
  element.replaceChildren();
  const image = document.createElement("img");
  image.className = "tc-website-fallback";
  image.alt = "";
  image.src = src;
  element.appendChild(image);
  return image;
}
