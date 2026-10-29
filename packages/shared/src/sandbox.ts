// Fixed MVP profile: callers choose bounded lifetime, never arbitrary images or Docker flags.
export const SANDBOX_RESOURCES = { cpus: 1, memoryMb: 1024, workspaceMb: 128, pids: 256 } as const;
export const SANDBOX_LIMITS = {
  workers: 2, concurrency: 1, dailyAllocatedSeconds: 3600, dailyArtifactBytes: 100 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024, artifactBytes: 32 * 1024 * 1024, outputBytes: 64 * 1024,
  executions: 120, retentionDays: 7,
} as const;
export const sandboxTerminal = (state: string) => ["terminated", "expired", "failed"].includes(state);
export const executionTerminal = (state: string) => !["queued", "running"].includes(state);
export function sandboxPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 240 || !value || value.startsWith("/") || value.split("/").some(p => !p || p === "." || p === "..") || /[\x00-\x1f\\]/.test(value)) throw new Error("path must be a relative workspace file path without dot segments");
  return value;
}
export function sandboxKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error("key must contain 1–80 letters, digits, underscores, or hyphens");
  return value;
}
export function sandboxInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`expected an integer from ${min} to ${max}`);
  return n;
}
