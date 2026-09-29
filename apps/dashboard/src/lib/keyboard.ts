const interactiveShortcutTargetSelector = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='option']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='tab']",
  "[role='treeitem']",
].join(",");

/** Return whether a focused interactive or editable control should own its keys. */
export function isInteractiveShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target.closest(interactiveShortcutTargetSelector)) return true;

  return Boolean(
    target.closest("[contenteditable]:not([contenteditable='false'])"),
  );
}
