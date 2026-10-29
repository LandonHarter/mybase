import { describe, expect, test } from "bun:test";
import { composeProfile } from "./server-env";
import { sandboxHost, sandboxImages, sandboxProfileOn, sandboxSettings } from "./server-sandbox-env";
import { checkSandboxDocker, gvisorArchiveMembers, gvisorChecksum, type SandboxDockerInfo } from "./server-gvisor";

const key = "a".repeat(64);
const docker: SandboxDockerInfo = {
  Architecture: "x86_64", OperatingSystem: "Ubuntu", KernelVersion: "6.8.0", CgroupVersion: "2",
  MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true, Runtimes: {},
};

describe("sandbox host settings", () => {
  test("preserves unrelated profiles and worker credentials", () => {
    const settings = sandboxSettings({
      COMPOSE_PROFILES: "tunnel", MYBASE_PUBLIC_URL: "https://mybase.example.com",
      MYBASE_S3_PUBLIC_URL: "https://s3.example.com", MYBASE_SANDBOX_WORKER_KEY: key,
    }, { publicIp: "8.8.8.8", version: "1.2.3" });
    expect(settings.COMPOSE_PROFILES).toBe("tunnel,sandbox");
    expect(settings.MYBASE_SANDBOX_WORKER_KEY).toBe(key);
    expect(settings.MYBASE_SANDBOX_DENY_HOSTS).toBe("localhost,mybase.example.com,s3.example.com,8.8.8.8");
    expect(settings.MYBASE_SANDBOX_IMAGE).toBe("ghcr.io/landonharter/mybase-sandbox:1.2.3");
    expect(settings.MYBASE_SANDBOX_WORKER_IMAGE).toBe("ghcr.io/landonharter/mybase-sandbox-worker:1.2.3");
    expect(sandboxProfileOn(settings)).toBeTrue();
    expect(composeProfile(settings.COMPOSE_PROFILES, "tunnel", false)).toBe("sandbox");
  });

  test("uses the API's commit tag for master deployments and local overrides", () => {
    expect(sandboxImages({ MYBASE_IMAGE: "ghcr.io/landonharter/mybase:sha-1234567" }, "1.2.3").image)
      .toBe("ghcr.io/landonharter/mybase-sandbox:sha-1234567");
    expect(sandboxImages({}, "1.2.3", { image: "mybase-sandbox:local", workerImage: "mybase-sandbox-worker:local" }))
      .toEqual({ image: "mybase-sandbox:local", workerImage: "mybase-sandbox-worker:local", managed: false });
    expect(() => sandboxImages({ MYBASE_IMAGE: "mybase:local" }, "1.2.3")).toThrow("custom MYBASE_IMAGE");
  });

  test("requires a public deny address and rejects malformed hosts", () => {
    expect(() => sandboxSettings({}, { publicIp: null, version: "1.2.3" })).toThrow("--deny-hosts");
    expect(() => sandboxSettings({}, { publicIp: "127.0.0.1", version: "1.2.3" })).toThrow("--deny-hosts");
    expect(sandboxHost("https://mybase.example.com/path")).toBe("mybase.example.com");
    expect(() => sandboxHost("bad host")).toThrow("hostnames or IP addresses");
  });
});

describe("gVisor host validation", () => {
  test("requires local Linux Docker with all cgroup controllers", () => {
    expect(() => checkSandboxDocker(docker, "unix:///var/run/docker.sock")).not.toThrow();
    expect(() => checkSandboxDocker(docker, "tcp://remote:2375")).toThrow("remote daemon");
    expect(() => checkSandboxDocker({ ...docker, PidsLimit: false }, "unix:///var/run/docker.sock")).toThrow("cgroup v2");
    expect(() => checkSandboxDocker({ ...docker, OperatingSystem: "Docker Desktop" }, "unix:///var/run/docker.sock")).toThrow("Linux Docker host");
  });

  test("accepts only the expected signed release bundle layout", () => {
    expect(gvisorChecksum(`${"a".repeat(128)}  gvisor.tar.bz2\n`)).toBe("a".repeat(128));
    expect(() => gvisorChecksum("tampered")).toThrow("unexpected format");
    expect(() => gvisorArchiveMembers("./runsc\n./gvisor-bin/\n./gvisor-bin/gvisor_sentry\n")).not.toThrow();
    expect(() => gvisorArchiveMembers("runsc\ngvisor-bin/gvisor_sentry\n../escape")).toThrow("unexpected archive paths");
    expect(() => gvisorArchiveMembers("runsc")).toThrow("required sidecars");
  });
});
