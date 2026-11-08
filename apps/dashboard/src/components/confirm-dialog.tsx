import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { errorMessage } from "@/lib/api";

/**
 * A confirm step before an action takes effect. `destructive` (the default) is for anything that
 * can't be undone. `onConfirm` throws on failure: the dialog stays open, shows the error above the
 * buttons, and the confirm button becomes Retry. Callers don't catch.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  pendingLabel,
  onConfirm,
  destructive = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirm: string;
  pendingLabel: string;
  onConfirm: () => Promise<void>;
  destructive?: boolean;
  /** Options between the description and the buttons. */
  children?: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  async function run(e: MouseEvent) {
    // Keep the dialog open until the action finishes.
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {error && (
          <p role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} disabled={pending} onClick={run}>
            {pending ? pendingLabel : error ? "Retry" : confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
