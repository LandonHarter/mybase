import { useState } from "react";
import type { CacheCredentials, EnableServiceResponse } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Secrets a service hands out once: on enable, and on rotate. Only the cache has any (its TCP password). */
export type Credentials = EnableServiceResponse;

export const cacheCredentials = (credentials: CacheCredentials): Credentials => ({ service: "cache", credentials });

/**
 * Shows a new cache password. It isn't stored, so this is the only time
 * they're visible; the dialog says so and only closes with Done.
 */
export function CredentialsDialog({ credentials, onClose }: { credentials: Credentials | null; onClose: () => void }) {
  // Keep the last value while the dialog animates out.
  const [last, setLast] = useState(credentials);
  if (credentials && credentials !== last) setLast(credentials);
  const shown = credentials ?? last;

  return (
    <Dialog open={credentials !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
        {shown && (
          <div className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Cache password</DialogTitle>
              <DialogDescription>Copy it now. It isn't stored, so it can't be shown again. You can always rotate it for a new one.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <CopyField id="new-cache-url" label="Connection string (TCP)" value={shown.credentials.url} secret />
              <CopyField id="new-cache-password" label="Password" value={shown.credentials.password} secret />
              <p className="text-muted-foreground">
                Every key must start with <code className="font-mono text-[0.85em] text-foreground">{shown.credentials.keyPrefix}</code>. Over HTTP, apps use an API
                key with cache:write instead.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
