#!/usr/bin/env bun
// Sets the one mybase version everywhere a release checks it (cli.yml, sdk.yml):
//   ./scripts/set-version.ts 1.0.1      (or: bun run set-version 1.0.1)
// Then commit, push, and tag: git tag v1.0.1 && git push origin v1.0.1 (bun run release does all of it)
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export const VERSION_FILES: { path: string; pattern: RegExp; replace: (v: string) => string }[] = [
  { path: "packages/sdk/package.json", pattern: /"version": "[^"]*"/, replace: (v) => `"version": "${v}"` },
  { path: "apps/cli/package.json", pattern: /"version": "[^"]*"/, replace: (v) => `"version": "${v}"` },
  {
    path: "packages/shared/src/index.ts",
    pattern: /export const MYBASE_VERSION = "[^"]*"/,
    replace: (v) => `export const MYBASE_VERSION = "${v}"`,
  },
];

/** "v1.0.1" → "1.0.1"; null if it isn't a semver version. */
export function parseVersion(arg: string | undefined): string | null {
  const version = arg?.replace(/^v/, "");
  return version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

export async function setVersion(version: string): Promise<void> {
  // Check every file before writing any, so a failure never leaves versions out of step.
  const updates = await Promise.all(
    VERSION_FILES.map(async ({ path, pattern, replace }) => {
      const text = await Bun.file(resolve(root, path)).text();
      const current = text.match(pattern)?.[0];
      if (!current) throw new Error(`no version found in ${path}`);
      return { path, current, text: text.replace(pattern, replace(version)) };
    }),
  );

  for (const { path, current, text } of updates) {
    await Bun.write(resolve(root, path), text);
    console.log(`${path}: ${current.match(/"([^"]*)"$/)?.[1]} -> ${version}`);
  }
}

if (import.meta.main) {
  const version = parseVersion(process.argv[2]);
  if (!version) {
    console.error("usage: ./scripts/set-version.ts <version>   e.g. 1.0.1 or 1.1.0-beta.1");
    process.exit(1);
  }
  await setVersion(version);
  console.log(`\nNext: commit, push, then git tag v${version} && git push origin v${version}`);
}
