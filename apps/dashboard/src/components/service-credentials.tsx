import { useState } from "react";
import type { CacheCredentials, EnableServiceResponse, RateLimitKey } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Secrets a service hands out once: on enable, and on rotate. */
export type Credentials = EnableServiceResponse;

export const cacheCredentials = (credentials: CacheCredentials): Credentials => ({ service: "cache", credentials });
export const rateLimitCredentials = (key: RateLimitKey): Credentials => ({ service: "ratelimit", key });

/**
 * Shows a new cache password or rate limit key. Neither is stored, so this is the only time
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
              <DialogTitle>{shown.service === "cache" ? "Cache password" : "Rate limit key"}</DialogTitle>
              <DialogDescription>Copy it now. It isn't stored, so it can't be shown again. You can always rotate it for a new one.</DialogDescription>
            </DialogHeader>
            {shown.service === "cache" ? (
              <div className="grid gap-3">
                <CopyField id="new-cache-url" label="Connection string (TCP)" value={shown.credentials.url} secret />
                <CopyField id="new-cache-password" label="Password (HTTP Bearer token)" value={shown.credentials.password} secret />
                <p className="text-muted-foreground">
                  Every key must start with <code className="font-mono text-[0.85em] text-foreground">{shown.credentials.keyPrefix}</code>.
                </p>
              </div>
            ) : (
              <CopyField id="new-ratelimit-key" label="MYBASE_RATELIMIT_KEY" value={shown.key.key} secret />
            )}
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
