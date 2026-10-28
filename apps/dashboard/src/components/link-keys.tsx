import type { Project, ServiceId } from "@mybase/shared";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/load";
import { cn } from "@/lib/utils";

/** The project's linked secrets envs (`mybase secrets link`); none while loading or with secrets off. */
export function useLinkedEnvs(project: Project): string[] {
  const on = project.services.includes("secrets");
  const { state } = useLoad(`secrets-linked:${project.name}:${on}`, () => (on ? api.secrets(project.name) : Promise.resolve(null)));
  return state.status === "ready" && state.data ? state.data.envs.filter((e) => e.linked).map((e) => e.name) : [];
}

/** When turning a service on: whether its keys also go into the linked envs. Hidden without any. */
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
