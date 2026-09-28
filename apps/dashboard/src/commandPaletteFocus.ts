const commandPaletteDialogSelector = "dialog.command-palette-dialog[open]";

function focusCommandPaletteInput(dialog: Element) {
  const input = dialog.querySelector<HTMLInputElement>("[cmdk-input]");
  if (!input || document.activeElement === input) return;
  input.focus({ preventScroll: true });
}

function focusInsertedCommandPalettes(node: Node) {
  if (!(node instanceof Element)) return;
  if (node.matches(commandPaletteDialogSelector)) focusCommandPaletteInput(node);
  node
    .querySelectorAll(commandPaletteDialogSelector)
    .forEach(focusCommandPaletteInput);
}

export function installCommandPaletteFocus(
  root: Document | Element = document,
) {
  const observerTarget = root instanceof Document ? root.documentElement : root;

  root
    .querySelectorAll(commandPaletteDialogSelector)
    .forEach(focusCommandPaletteInput);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (
        record.type === "attributes" &&
        record.attributeName === "open" &&
        record.target instanceof Element &&
        record.target.matches(commandPaletteDialogSelector)
      ) {
        focusCommandPaletteInput(record.target);
      } else if (record.type === "childList") {
        record.addedNodes.forEach(focusInsertedCommandPalettes);
      }
    }
  });

  observer.observe(observerTarget, {
    attributes: true,
    attributeFilter: ["open"],
    childList: true,
    subtree: true,
  });

  return () => observer.disconnect();
}
