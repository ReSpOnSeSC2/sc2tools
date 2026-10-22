/**
 * Nothing on the page has focus any more: the focused control unmounted
 * (focus fell back to `<body>`). Focus is only moved back for the player
 * then, never taken from wherever they went meanwhile or from an open
 * dialog.
 */
export function focusWasLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}
