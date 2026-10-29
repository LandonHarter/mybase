// Host-owned resource controls. Apps never choose images, Docker flags, or resource budgets.
export const SANDBOX_RESOURCES = { cpus: 1, memoryMb: 1024, workspaceMb: 128, pids: 256, tmpMb: 256, shmMb: 64 };
export const SANDBOX_LIMITS = {
  fileBytes: 8 * 1024 * 1024, outputBytes: 64 * 1024,
  networkStreams: 32, networkIdleMs: 15_000,
};
export function sandboxConfig(raw?: string) {
  const config = { resources: { ...SANDBOX_RESOURCES }, limits: { ...SANDBOX_LIMITS } };
  if (!raw) return config;
  const input = JSON.parse(raw);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MYBASE_SANDBOX_CONFIG must be a JSON object");
  for (const group of Object.keys(input)) {
    if (group !== "resources" && group !== "limits") throw new Error(`unknown sandbox config group: ${group}`);
    const values = input[group];
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`sandbox ${group} must be an object`);
    const target = config[group] as Record<string, number>;
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(target, key)) throw new Error(`unknown sandbox ${group} setting: ${key}`);
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (key !== "cpus" && !Number.isSafeInteger(value))) throw new Error(`sandbox ${key} must be a positive ${key === "cpus" ? "number" : "safe integer"}`);
      target[key] = value;
    }
  }
  return config;
}
/** Missing/null disables a deadline. Bound only by representable wall-clock dates, not a usage policy. */
export function sandboxDuration(value: unknown, unitMs = 1000): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value * unitMs > 8_640_000_000_000_000 - Date.now()) throw new Error("duration must be a positive integer or null");
  return value;
}
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
