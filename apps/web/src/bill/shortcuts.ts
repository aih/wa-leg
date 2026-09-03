// One keyboard map, rendered as the help dialog and consumed by the viewer (design/research/bill-viewer.md section 4).
export type ShortcutAction =
  | 'next-section'
  | 'prev-section'
  | 'next-block'
  | 'prev-block'
  | 'section-top'
  | 'top'
  | 'bottom'
  | 'toggle-outline'
  | 'version-switcher'
  | 'compare'
  | 'toggle-overlay'
  | 'find'
  | 'cite'
  | 'copy'
  | 'toggle-lines'
  | 'help'
  | 'escape';

export interface Shortcut {
  keys: string[];
  action: ShortcutAction;
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ['j'], action: 'next-section', label: 'Next section' },
  { keys: ['k'], action: 'prev-section', label: 'Previous section' },
  { keys: [']'], action: 'next-block', label: 'Next top-level block in the section' },
  { keys: ['['], action: 'prev-block', label: 'Previous top-level block in the section' },
  { keys: ['u'], action: 'section-top', label: 'Top of the current section' },
  { keys: ['t'], action: 'top', label: 'Top of the bill' },
  { keys: ['b'], action: 'bottom', label: 'Bottom of the bill' },
  { keys: ['o'], action: 'toggle-outline', label: 'Toggle the outline' },
  { keys: ['v'], action: 'version-switcher', label: 'Version switcher' },
  { keys: ['d'], action: 'compare', label: 'Compare with the previous version' },
  { keys: ['a'], action: 'toggle-overlay', label: 'Toggle the amendment overlay' },
  { keys: ['/'], action: 'find', label: 'Find in bill' },
  { keys: ['.'], action: 'cite', label: 'Cite the current selection or section' },
  { keys: ['c'], action: 'copy', label: 'Copy the current section' },
  { keys: ['l'], action: 'toggle-lines', label: 'Toggle line numbers' },
  { keys: ['?'], action: 'help', label: 'Keyboard help' },
  { keys: ['Escape'], action: 'escape', label: 'Close the compare view, picker, find box or help' },
];

const byKey = new Map<string, ShortcutAction>();
for (const s of SHORTCUTS) for (const k of s.keys) byKey.set(k, s.action);

/** Resolve a keydown to an action, or null. Modifier combinations and text fields are ignored. */
export function actionForKey(e: KeyboardEvent): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
      return e.key === 'Escape' ? 'escape' : null;
    }
  }
  return byKey.get(e.key) ?? null;
}
