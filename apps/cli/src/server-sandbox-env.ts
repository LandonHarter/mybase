// Pure sandbox deployment decisions. Host privileges and Docker operations live elsewhere.
import { isIP } from "node:net";
import { publicSandboxIp } from "@mybase/shared/public-ip";
import { composeProfile } from "./server-env";
import { CliError } from "./output";

export const LOCAL_SANDBOX_WORKER = "http://sandbox-worker:4010";
const IMAGE_ROOT = "ghcr.io/landonharter/mybase";
export const sandboxProfileOn = (values: Record<string, string>) => (values.COMPOSE_PROFILES ?? "").split(",").some(p => p.trim() === "sandbox");
export const imageTag = (value: string) => /^(?:\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?|sha-[a-f0-9]{7,40})$/.test(value);

/** Prefer explicit API tags; for :latest the pulled image's version label pins matching companions. */
export function sandboxImages(values: Record<string, string>, version: string, overrides: { image?: string; workerImage?: string } = {}) {
  const apiImage = values.MYBASE_IMAGE || `${IMAGE_ROOT}:latest`;
  const official = apiImage === IMAGE_ROOT || apiImage.startsWith(`${IMAGE_ROOT}:`);
  const configuredTag = apiImage.startsWith(`${IMAGE_ROOT}:`) ? apiImage.slice(IMAGE_ROOT.length + 1) : "latest";
  const tag = imageTag(configuredTag) ? configuredTag : version.replace(/^v/, "");
  const managed = !overrides.image && !overrides.workerImage &&
    (values.MYBASE_SANDBOX_MANAGED_IMAGES === "1" || (!values.MYBASE_SANDBOX_IMAGE && !values.MYBASE_SANDBOX_WORKER_IMAGE));
  if (managed && !official) throw new CliError("custom MYBASE_IMAGE: pass --image <guest-image> --worker-image <worker-image> once; matching sandbox images cannot be inferred from a custom build");
  if (!imageTag(tag)) throw new CliError("cannot determine a matching sandbox image tag; pass --image and --worker-image");
  const image = overrides.image || (!managed && values.MYBASE_SANDBOX_IMAGE) || `${IMAGE_ROOT}-sandbox:${tag}`;
  const workerImage = overrides.workerImage || (!managed && values.MYBASE_SANDBOX_WORKER_IMAGE) || `${IMAGE_ROOT}-sandbox-worker:${tag}`;
  for (const value of [image, workerImage]) {
    if (value.startsWith("-") || /\s|\x00/.test(value)) throw new CliError("sandbox images must be Docker image references");
  }
  return { image, workerImage, managed };
}

export function sandboxHost(value: string): string {
  const clean = value.trim();
  if (!clean || /[\s\x00-\x1f]/.test(clean)) throw new CliError("sandbox deny hosts must be comma-separated hostnames or IP addresses");
  if (isIP(clean)) return clean.toLowerCase();
  try {
    const host = new URL(clean.includes("://") ? clean : `http://${clean}`).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return host;
  } catch {}
  throw new CliError("sandbox deny hosts must be valid hostnames or IP addresses");
}

export function sandboxSettings(values: Record<string, string>, options: {
  publicIp?: string | null; extraHosts?: string; image?: string; workerImage?: string; version: string;
}): Record<string, string> {
  if (values.MYBASE_SANDBOX_WORKER_URL && values.MYBASE_SANDBOX_WORKER_URL.replace(/\/$/, "") !== LOCAL_SANDBOX_WORKER) {
    throw new CliError("a custom/remote sandbox worker is configured; this command sets up the local Compose worker. Keep managing the remote worker on its Docker host, or remove MYBASE_SANDBOX_WORKER_URL to switch to local setup");
  }
  const hosts = new Set<string>(["localhost"]);
  for (const key of ["MYBASE_PUBLIC_HOST", "MYBASE_PUBLIC_URL", "MYBASE_S3_PUBLIC_URL", "MYBASE_DB_PUBLIC_HOST", "MYBASE_CACHE_PUBLIC_HOST"]) {
    if (values[key]) hosts.add(sandboxHost(values[key]!));
  }
  for (const host of `${values.MYBASE_SANDBOX_DENY_HOSTS ?? ""},${options.extraHosts ?? ""}`.split(",").filter(h => h.trim())) hosts.add(sandboxHost(host));
  if (options.publicIp && publicSandboxIp(options.publicIp)) hosts.add(options.publicIp);
  // Public NAT addresses cannot be inferred from a Cloudflare-proxied hostname alone.
  if (![...hosts].some(h => isIP(h) && publicSandboxIp(h))) {
    throw new CliError("couldn't detect this server's public IP. Retry when internet access is available, or pass --deny-hosts <public-router/server-IP> (additional comma-separated hosts are accepted)");
  }
  const key = values.MYBASE_SANDBOX_WORKER_KEY || Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  if (key.length < 32) throw new CliError("existing MYBASE_SANDBOX_WORKER_KEY is too short; replace it with at least 32 random characters");
  const images = sandboxImages(values, options.version, options);
  return {
    COMPOSE_PROFILES: composeProfile(values.COMPOSE_PROFILES, "sandbox", true)!,
    MYBASE_SANDBOX_WORKER_URL: LOCAL_SANDBOX_WORKER,
    MYBASE_SANDBOX_WORKER_KEY: key,
    MYBASE_SANDBOX_DENY_HOSTS: [...hosts].join(","),
    MYBASE_SANDBOX_IMAGE: images.image,
    MYBASE_SANDBOX_WORKER_IMAGE: images.workerImage,
    MYBASE_SANDBOX_MANAGED_IMAGES: images.managed ? "1" : "0",
  };
}
