import type { HostCommand } from '../host';

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
/** Hold to comment: Ctrl+Alt (Windows/Linux), ⌘+⌥ on macOS where Ctrl+click is the context menu. */
export const HOLD_LABEL = isMac ? '⌘+⌥' : 'Strg+Alt';
export function holdPressed(e: KeyboardEvent | MouseEvent): boolean {
  // AltGr is reported as Ctrl+Alt on Windows; typing "@" or "€" must not trigger the picker.
  if (e.getModifierState?.('AltGraph') || e.shiftKey) return false;
  return isMac ? e.metaKey && e.altKey : e.ctrlKey && e.altKey && !e.metaKey;
}

export type Command = HostCommand | 'region' | 'note' | 'list';
/** Pressed together with the hold keys. Avoids Ctrl+Alt+L/T/D (lock screen, terminal, desktop on Linux). */
export const SHORTCUTS: Record<string, Command> = {
  KeyB: 'region',
  KeyN: 'note',
  KeyK: 'list',
  KeyH: 'toggle-toolbar',
  KeyE: 'export',
};
