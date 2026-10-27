#!/usr/bin/env bun
// Releases a new version in one go:
//   bun run release 1.0.1
// Sets the version (set-version.ts), runs the checks CI runs, commits the version files, pushes
// master, then tags v1.0.1 and pushes the tag (which publishes npm packages, the CLI release, and
// images). Refuses to start unless it's on an up-to-date, clean master and the tag is new.
import { $ } from "bun";
import { resolve } from "node:path";
import { VERSION_FILES, parseVersion, setVersion } from "./set-version";

$.cwd(resolve(import.meta.dir, ".."));

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

const version = parseVersion(process.argv[2]);
if (!version) fail("usage: bun run release <version>   e.g. 1.0.1 or 1.1.0-beta.1");
const tag = `v${version}`;

// Nothing below changes anything until every check has passed.
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "master") fail(`on branch ${branch}, releases come from master`);
if ((await $`git status --porcelain`.text()).trim()) fail("uncommitted changes; commit or stash them first");
if ((await $`git tag --list ${tag}`.text()).trim()) fail(`tag ${tag} already exists locally`);
if ((await $`git ls-remote --tags origin refs/tags/${tag}`.text()).trim()) fail(`tag ${tag} already exists on origin`);
await $`git fetch --quiet origin master`;
if ((await $`git rev-list --count HEAD..origin/master`.text()).trim() !== "0") fail("origin/master has commits you don't; pull first");

await setVersion(version);

console.log("\nChecking (same as CI)...");
const checks = await $`bun install --frozen-lockfile && bun run typecheck && bun run test`.nothrow();
if (checks.exitCode !== 0) {
  await $`git checkout -- ${VERSION_FILES.map((f) => f.path)}`;
  fail("checks failed; version files reset, nothing committed");
}

await $`git add -- ${VERSION_FILES.map((f) => f.path)}`;
await $`git commit --quiet -m ${tag}`;
await $`git push --quiet origin master`;
await $`git tag ${tag}`;
await $`git push --quiet origin ${tag}`;

const repo = (await $`git remote get-url origin`.text()).trim().replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
console.log(`\nReleased ${tag}. Watch it: ${repo}/actions`);
