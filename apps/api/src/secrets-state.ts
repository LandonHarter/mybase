// Pure helpers for secrets.ts: branch resolution and rewinding history. No database, no crypto.

/** One recorded change: ciphertexts before and after (null = the key didn't exist). */
export interface StoredChange {
  revision: number;
  key: string;
  oldValue: Uint8Array | null;
  newValue: Uint8Array | null;
  managed: boolean;
}

/** A branch env sees its parent's keys, overridden by its own. */
export function overlay<T>(parent: Map<string, T> | null, own: Map<string, T>): Map<string, T & { inherited: boolean }> {
  const out = new Map<string, T & { inherited: boolean }>();
  for (const [key, row] of parent ?? []) out.set(key, { ...row, inherited: true });
  for (const [key, row] of own) out.set(key, { ...row, inherited: false });
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The env's values as they were at an earlier revision: `current` with every change after it
 * undone, newest first. `changes` must be all changes after that revision. Keys touched by a
 * `mybase secrets link` write are reported in `skipped`: credentials are never rolled back.
 */
export function rewind(current: Map<string, Uint8Array>, changes: StoredChange[]): { target: Map<string, Uint8Array>; skipped: Set<string> } {
  const target = new Map(current);
  const skipped = new Set<string>();
  for (const c of [...changes].sort((a, b) => b.revision - a.revision)) {
    if (c.managed) skipped.add(c.key);
    if (c.oldValue === null) target.delete(c.key);
    else target.set(c.key, c.oldValue);
  }
  return { target, skipped };
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
