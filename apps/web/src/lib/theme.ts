/** Colour theme. Light is the default; the reader can switch to dark, and the choice is kept per browser. */
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/** Read by the inline script in index.html too, which applies the stored theme before first paint. */
export const THEME_KEY = 'ui.theme';

export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function useTheme(): { theme: Theme; toggle(): void } {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle };
}
