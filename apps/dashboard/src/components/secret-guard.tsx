import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * One-time credentials (project, API key, cache password) can't be shown again, so an accidental
 * outside click or Escape doesn't close their dialog (P10): it asks first. Spread `contentProps`
 * on `DialogContent`, render `notice`, and call `close` from the "I saved these" button.
 */
export function useSecretGuard(active: boolean, onClose: () => void) {
  const [asking, setAsking] = useState(false);
  const stop = (e: Event) => {
    if (!active) return;
    e.preventDefault();
    setAsking(true);
  };
  const close = () => {
    setAsking(false);
    onClose();
  };
  return {
    contentProps: { onInteractOutside: stop, onEscapeKeyDown: stop },
    /** For the dialog's own close (X) handler: ask instead of closing while active. */
    requestClose: () => (active ? setAsking(true) : close()),
    close,
    notice: asking ? (
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/12 p-3">
        <p className="min-w-0 flex-1">Close without saving these? They can't be shown again.</p>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>
          Keep open
        </Button>
        <Button type="button" size="sm" variant="danger-outline" onClick={close}>
          Discard
        </Button>
      </div>
    ) : null,
  };
}
