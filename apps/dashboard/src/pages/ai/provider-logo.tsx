import { cn } from "@/lib/utils";
import { LOGOS } from "@/pages/ai/logos";

// Gateway provider id or model maker (`vercel/<maker>/…`) → models.dev logo id, where they differ.
const LOGO_ID: Record<string, string> = {
  bedrock: "amazon-bedrock",
  together: "togetherai",
  fireworks: "fireworks-ai",
  "x-ai": "xai",
  spacexai: "xai",
  mistralai: "mistral",
  "meta-llama": "meta",
  "z-ai": "zai",
  zhipuai: "zai",
  qwen: "alibaba",
};

const logoFor = (id: string) => LOGOS[LOGO_ID[id] ?? id] ?? null;

/**
 * The model maker's logo for a catalog id: `vercel/anthropic/claude-…` shows Anthropic, not Vercel.
 * Falls back to the provider.
 */
export function makerOf(modelId: string): string {
  const [provider, ...rest] = modelId.split("/");
  if ((provider === "vercel" || provider === "openrouter") && rest.length > 1 && logoFor(rest[0]!)) return rest[0]!;
  return provider!;
}

/** A provider's logo (monochrome, follows the theme), or its initial for custom providers. */
export function ProviderLogo({ id, name, className }: { id: string; name?: string; className?: string }) {
  const svg = logoFor(id);
  return (
    <span
      aria-hidden
      title={name}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-foreground [&>svg]:size-4",
        !svg && "text-xs font-semibold text-muted-foreground uppercase",
        className,
      )}
      // Generated from models.dev and checked by scripts/gen-ai-logos.ts (shapes only, no scripts or links).
      {...(svg ? { dangerouslySetInnerHTML: { __html: svg } } : { children: (name ?? id).slice(0, 1) })}
    />
  );
}
