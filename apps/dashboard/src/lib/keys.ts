const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Label for the command menu shortcut, matching the user's OS. */
export const SEARCH_SHORTCUT = isMac ? "⌘K" : "Ctrl K";

/** Label for Ctrl/⌘+Enter (run), matching the user's OS. */
export const RUN_SHORTCUT = isMac ? "⌘↵" : "Ctrl ↵";
