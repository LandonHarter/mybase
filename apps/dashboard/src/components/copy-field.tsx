import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A labelled, read-only value with a copy button: for anything the user pastes into an app.
 * `secret` masks the value until the user reveals it.
 */
export function CopyField({ id, label, value, secret = false }: { id: string; label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it by hand.");
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          type={secret && !revealed ? "password" : "text"}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs md:text-xs"
        />
        {secret && (
          <Button type="button" variant="outline" size="icon" onClick={() => setRevealed(!revealed)} aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}>
            {revealed ? <EyeOff /> : <Eye />}
          </Button>
        )}
        <Button type="button" variant="outline" size="icon" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}
