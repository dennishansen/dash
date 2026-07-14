// Theme source of truth is the data-theme attribute on <html> — set pre-paint
// by an inline script in dash/index.html. The user's CHOICE (mode) is persisted
// under 'dash-theme': 'light' | 'dark' | absent = automatic (follow the OS).
// Absence of the attribute means dark. Everything CSS reads the attribute via
// :root[data-theme='light']; JS consumers (xterm) subscribe via onThemeChange.

const systemLight = window.matchMedia('(prefers-color-scheme: light)');

export function getTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function getMode() {
  const m = localStorage.getItem('dash-theme');
  return m === 'light' || m === 'dark' ? m : 'auto';
}

export function setMode(mode) {
  if (mode === 'auto') localStorage.removeItem('dash-theme');
  else localStorage.setItem('dash-theme', mode);
  apply();
}

function apply() {
  const mode = getMode();
  const light = mode === 'auto' ? systemLight.matches : mode === 'light';
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
}

// In automatic mode, follow the OS live.
systemLight.addEventListener('change', () => { if (getMode() === 'auto') apply(); });

// Watch the <html> attribute itself so every consumer follows ANY theme
// change (toggle button, another tab via storage, devtools). Returns unsubscribe.
export function onThemeChange(fn) {
  const mo = new MutationObserver(() => fn(getTheme()));
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

// xterm can't read CSS variables — mirror the two palettes here.
export const XTERM_THEMES = {
  dark: {
    background: '#0c0d10',
    foreground: '#e7e9ed',
    cursor: '#6aa9ff',
    cursorAccent: '#0c0d10',
    selectionBackground: '#2e3440',
    black: '#14161b', red: '#ff7c7c', green: '#5ee3a6', yellow: '#ffcc66',
    blue: '#6aa9ff', magenta: '#c4a3ff', cyan: '#66b8ff', white: '#e7e9ed',
    brightBlack: '#5d6472', brightRed: '#ff9a9a', brightGreen: '#8bf0c4',
    brightYellow: '#ffd98a', brightBlue: '#8bc1ff', brightMagenta: '#d6bcff',
    brightCyan: '#8fd0ff', brightWhite: '#ffffff',
  },
  light: {
    background: '#fdfdfe',
    foreground: '#1f2430',
    cursor: '#2b66d9',
    cursorAccent: '#fdfdfe',
    selectionBackground: '#c9d8f0',
    black: '#1f2430', red: '#c93c3c', green: '#178a5a', yellow: '#9a6b00',
    blue: '#2b66d9', magenta: '#7c4fd0', cyan: '#1f6fc2', white: '#d9dde5',
    brightBlack: '#5d6778', brightRed: '#e06666', brightGreen: '#1fae74',
    brightYellow: '#b8860b', brightBlue: '#4a82e8', brightMagenta: '#9a73e0',
    brightCyan: '#3a8fd6', brightWhite: '#f4f5f8',
  },
};
