import type { Project, ServiceId } from "@mybase/shared";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/load";
import { cn } from "@/lib/utils";

export type LinkedEnvs = { status: "loading" } | { status: "error"; message: string; retry: () => void } | { status: "ready"; envs: string[] };

/**
 * The project's linked secrets envs (`mybase secrets link`): those get a new service's keys when it
 * is turned on. Explicit loading/error so enabling never guesses (A06). Shares the secrets page's cache.
 */
export function useLinkedEnvs(project: Project): LinkedEnvs {
  const on = project.services.includes("secrets");
  const load = useLoad(`secrets:${project.name}${on ? "" : ":off"}`, () => (on ? api.secrets(project.name) : Promise.resolve(null)));
  if (!on) return { status: "ready", envs: [] };
  if (load.state.status === "loading") return { status: "loading" };
  if (load.state.status === "error") return { status: "error", message: load.state.message, retry: () => void load.refresh() };
  return { status: "ready", envs: load.state.data?.envs.filter((e) => e.linked).map((e) => e.name) ?? [] };
}

/** When turning a service on: whether its keys also go into the linked envs (named). Hidden without any. */
export function LinkKeysOption({
  id,
  envs,
  checked,
  onCheckedChange,
  className,
}: {
  id: ServiceId;
  envs: string[];
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  className?: string;
}) {
  if (envs.length === 0 || id === "secrets") return null;
  return (
    <label className={cn("flex items-start gap-2.5", className)}>
      <Switch size="sm" className="mt-0.5" checked={checked} onCheckedChange={onCheckedChange} />
      <span>
        Add its keys to the linked secrets {envs.length === 1 ? "env" : "envs"} <span className="font-mono text-[0.9em]">{envs.join(", ")}</span>
      </span>
    </label>
  );
}
