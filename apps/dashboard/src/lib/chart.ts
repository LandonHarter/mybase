/** A round axis maximum at or above `n` (1, 2, 5 × 10^k), so gridlines land on readable values. */
export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 5, 10]) if (n <= step * exp) return step * exp;
  return 10 * exp;
}
