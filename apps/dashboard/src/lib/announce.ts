/**
 * Polite screen-reader announcements ("Copied database URL", "Saved"), through one shared live
 * region. Use for completion states only, never for whole tables (DESIGN.md "Accessibility").
 */
let region: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function announce(message: string) {
  if (typeof document === "undefined") return;
  if (!region) {
    region = document.createElement("div");
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.className = "sr-only";
    document.body.appendChild(region);
  }
  // Clear first so repeating the same message is announced again.
  region.textContent = "";
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (region) region.textContent = message;
  }, 50);
}
