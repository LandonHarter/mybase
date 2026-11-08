import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { announce } from "./announce";

/**
 * Copies text. `navigator.clipboard` only exists in secure contexts, and the default install is
 * plain `http://<lan-ip>:4000`, so this falls back to a hidden textarea + `execCommand("copy")`.
 * Throws when both fail (show the value so the user can copy it by hand).
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or not focused: try the fallback below.
    }
  }
  const active = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  // Inside a modal dialog, focus is trapped there: append next to the focused element.
  (active?.closest("[role=dialog],[role=alertdialog]") ?? document.body).appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Couldn't copy. Select the text and copy it by hand.");
  } finally {
    textarea.remove();
    active?.focus?.({ preventScroll: true });
  }
}

/**
 * Copy with feedback: `copied` turns on for 1.5 s (and resets when `resetOn` changes), the copy is
 * announced politely, and a failure becomes a toast that tells the user to copy by hand.
 */
export function useCopy(resetOn?: unknown) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    clearTimeout(timer.current);
    setCopied(false);
  }, [resetOn]);
  const copy = useCallback(async (text: string, label?: string) => {
    try {
      await copyText(text);
      setCopied(true);
      announce(label ? `Copied ${label}` : "Copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
      return true;
    } catch {
      toast.error("Couldn't copy. Select the text and copy it by hand.");
      return false;
    }
  }, []);
  return { copied, copy };
}
