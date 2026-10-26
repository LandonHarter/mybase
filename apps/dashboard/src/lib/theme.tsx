import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const MODES = ["light", "dark", "system"] as const;
export const ACCENTS = ["moss", "cobalt", "raspberry", "amber", "graphite"] as const;

export type Mode = (typeof MODES)[number];
export type Accent = (typeof ACCENTS)[number];

// Keep these keys in sync with the no-flash script in index.html.
const MODE_KEY = "mybase.mode";
const ACCENT_KEY = "mybase.accent";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice still applies for this visit.
  }
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

interface ThemeContextValue {
  mode: Mode;
  accent: Accent;
  /** The mode actually shown, with "system" resolved. */
  resolvedMode: "light" | "dark";
  setMode: (mode: Mode) => void;
  setAccent: (accent: Accent) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => read(MODE_KEY, MODES, "system"));
  const [accent, setAccentState] = useState<Accent>(() => read(ACCENT_KEY, ACCENTS, "moss"));
  const [prefersDark, setPrefersDark] = useState(systemDark);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setPrefersDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolvedMode = mode === "system" ? (prefersDark ? "dark" : "light") : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolvedMode === "dark");
    if (accent === "moss") root.removeAttribute("data-accent");
    else root.dataset.accent = accent;
  }, [resolvedMode, accent]);

  const setMode = (next: Mode) => {
    setModeState(next);
    write(MODE_KEY, next);
  };
  const setAccent = (next: Accent) => {
    setAccentState(next);
    write(ACCENT_KEY, next);
  };

  return (
    <ThemeContext value={{ mode, accent, resolvedMode, setMode, setAccent }}>{children}</ThemeContext>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
