/** Apple platforms reserve Control-click for the native context menu. */
export function isAppleControlClick(event: { ctrlKey: boolean }): boolean {
  return event.ctrlKey && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}
