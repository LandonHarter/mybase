// `mybase server registry`: turns the container registry on or off on this machine (the
// `registry` compose profile; the `hosting` profile starts it too), and runs garbage collection.
import * as p from "@clack/prompts";
import { join } from "node:path";
import { styleText } from "node:util";
import { CliError, jsonMode, print, usageError } from "./output";
import { compose } from "./server-docker";
import { composeProfile, mergeEnv, parseEnv } from "./server-env";
import { hostingProfileOn } from "./server-hosting";
import { serverDir, startStack } from "./server-setup";

const profileOn = (values: Record<string, string>, name: string) => (values.COMPOSE_PROFILES ?? "").split(",").some((s) => s.trim() === name);
export const registryProfileOn = (values: Record<string, string>) => profileOn(values, "registry") || hostingProfileOn(values);

export async function setupRegistryServer(args: string[]) {
  const [sub] = args.filter((a) => !a.startsWith("-") && args[args.indexOf(a) - 1] !== "--dir");
  if (sub !== undefined && sub !== "gc") throw usageError(`unknown command: mybase server registry ${sub}`);
  const dir = await serverDir(args);
  const envFile = Bun.file(join(dir, ".env"));
  if (!(await envFile.exists())) throw new CliError(`no mybase server in ${dir}. Run \`mybase server setup\` (or pass --dir).`, 4);
  const text = await envFile.text();
  const values = parseEnv(text);
  if (sub === "gc") return gc(dir, values, args.includes("--untagged"));
  if (!jsonMode) p.intro(`${styleText("bold", " mybase ")} ${styleText("dim", "server registry")}`);

  if (args.includes("--off")) {
    if (hostingProfileOn(values)) throw new CliError("hosting is on here, and it keeps site images in the registry. Run `mybase server hosting --off` first.");
    await Bun.write(join(dir, ".env"), mergeEnv(text, { COMPOSE_PROFILES: composeProfile(values.COMPOSE_PROFILES, "registry", false) }));
    // Images stay on the registry-data volume; turning it back on brings them back.
    await compose(dir, ["--profile", "registry", "rm", "-sf", "registry"]);
    await startStack(dir, values, false);
    return print({ dir, registry: false }, () => p.outro("Registry off: docker push and pull to this server stop working. Images are kept on disk."));
  }

  await Bun.write(join(dir, ".env"), mergeEnv(text, { COMPOSE_PROFILES: composeProfile(values.COMPOSE_PROFILES, "registry", true) }));
  const version = await startStack(dir, values);
  print({ dir, version, registry: true }, () => p.outro("Registry is on. Next: mybase registry enable <project>, then mybase registry info <project>."));
}

/**
 * Frees the disk space of deleted images. With hosting on, the hosting worker also does this daily.
 * `--untagged` also deletes manifests no tag points at; hosting pushes site images by digest
 * (untagged), so it's refused while hosting is on.
 */
async function gc(dir: string, values: Record<string, string>, untagged: boolean) {
  if (!registryProfileOn(values)) throw new CliError("the registry isn't on here (mybase server registry)");
  if (untagged && hostingProfileOn(values)) throw new CliError("--untagged would delete every hosted site's images (they're pushed by digest, without tags). Run it without --untagged.");
  if (!jsonMode) console.error("Collecting garbage; pushes during this can fail. This can take a few minutes.");
  const run = await compose(dir, ["exec", "-T", "registry", "registry", "garbage-collect", "/etc/distribution/config.yml", ...(untagged ? ["--delete-untagged"] : [])]);
  if (!run.ok) throw new CliError(`garbage collection failed:\n${run.stderr || run.stdout}`);
  const freed = run.stdout.split("\n").filter((l) => /blob eligible for deletion/.test(l)).length;
  print({ dir, blobsDeleted: freed, untagged }, () => console.log(`Done: ${freed} blob${freed === 1 ? "" : "s"} deleted.`));
}
