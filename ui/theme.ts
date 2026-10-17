export type Theme = "light" | "dark" | "auto";

const KEY = "xz-theme";
const root = () => document.documentElement;

/** Forces a theme (kept in localStorage); "auto" follows the system. */
export function setTheme(theme: Theme): void {
  if (theme === "auto") delete root().dataset["theme"];
  else root().dataset["theme"] = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be off (private mode); the theme still applies to this page.
  }
}

/** The theme in effect now, resolving "auto" through the system preference. */
export function currentTheme(): "light" | "dark" {
  const forced = root().dataset["theme"];
  if (forced === "light" || forced === "dark") return forced;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function toggleTheme(): "light" | "dark" {
  const next = currentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

try {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") root().dataset["theme"] = saved;
} catch {
  // No storage: start with the system theme.
}
