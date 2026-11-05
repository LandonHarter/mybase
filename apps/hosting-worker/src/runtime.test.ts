import { describe, expect, test } from "bun:test";
import { BadInput, containerName, parseLabels, PROBE_HOST, probeHealthy, probeReachable, readSpec, runArgs } from "./runtime";

const deploy = "0f1e2d3c-4b5a-4678-9abc-def012345678";
const image = `127.0.0.1:5000/shop/web@sha256:${"a".repeat(64)}`;
const spec = { project: "shop", site: "web", image, env: { DATABASE_URL: "postgres://x\ny", PORT: "3000" }, memory: "512m" };

test("readSpec validates everything that reaches argv", () => {
  expect(readSpec(deploy, spec).site).toBe("web");
  expect(() => readSpec("nope", spec)).toThrow(BadInput);
  expect(() => readSpec(deploy, { ...spec, image: "evil/image:latest" })).toThrow(BadInput);
  expect(() => readSpec(deploy, { ...spec, image: `--privileged ${image}` })).toThrow(BadInput);
  expect(() => readSpec(deploy, { ...spec, site: "-x" })).toThrow(BadInput);
  expect(() => readSpec(deploy, { ...spec, memory: "1g; rm" })).toThrow(BadInput);
  expect(() => readSpec(deploy, { ...spec, env: { "BAD-NAME": "x" } })).toThrow(BadInput);
});

test("env names that would steer the docker client are refused", () => {
  for (const name of ["DOCKER_HOST", "DOCKER_CONFIG", "LD_PRELOAD", "PATH", "HOME"]) {
    expect(() => readSpec(deploy, { ...spec, env: { [name]: "x" } })).toThrow(BadInput);
  }
});

test("env values never reach argv", () => {
  const args = runArgs(readSpec(deploy, spec));
  expect(args).toContain("-e");
  expect(args).toContain("DATABASE_URL");
  expect(args.join(" ")).not.toContain("postgres://");
  expect(args).toContain(containerName("web", deploy));
  expect(args).toContain("--network");
  expect(args).toContain("mybase-p-shop");
  expect(args.at(-1)).toBe(image);
  expect(args).not.toContain("--privileged");
});

test("parseLabels", () => {
  expect(parseLabels("mybase.hosting=true,mybase.site=web,mybase.deploy=abc")).toEqual({ "mybase.hosting": "true", "mybase.site": "web", "mybase.deploy": "abc" });
});

test("probeHealthy: any HTTP answer below 500", () => {
  expect(probeHealthy({ code: 0, out: "", err: "" })).toBe(true);
  expect(probeHealthy({ code: 1, out: "", err: "  HTTP/1.1 404 Not Found\nwget: server returned error: HTTP/1.1 404 Not Found" })).toBe(true);
  expect(probeHealthy({ code: 1, out: "", err: "  HTTP/1.1 502 Bad Gateway" })).toBe(false);
  expect(probeHealthy({ code: 1, out: "", err: "wget: can't connect to remote host: Connection refused" })).toBe(false);
});

describe("probeReachable", () => {
  const r = (code: number, err: string) => ({ code, out: "", err });
  test("any answer counts, even a protocol mismatch", () => {
    expect(probeReachable(r(0, "")).reachable).toBe(true);
    expect(probeReachable(r(1, "wget: error getting response: Connection reset by peer")).reachable).toBe(true);
    expect(probeReachable(r(1, "wget: server returned error: HTTP/1.1 400 Bad Request")).reachable).toBe(true);
  });
  test("dead addresses don't", () => {
    expect(probeReachable(r(1, "wget: bad address 'db.example.com'"))).toEqual({ reachable: false, reason: "the name doesn't resolve" });
    expect(probeReachable(r(1, "wget: can't connect to remote host (68.40.207.134): Connection refused")).reason).toBe("connection refused");
    expect(probeReachable(r(1, "wget: download timed out")).reason).toBe("timed out");
    expect(probeReachable(r(1, "wget: can't connect to remote host: No route to host")).reachable).toBe(false);
  });
  test("probe hosts", () => {
    expect(PROBE_HOST.test("db.hangdong.lol")).toBe(true);
    expect(PROBE_HOST.test("postgres")).toBe(true);
    expect(PROBE_HOST.test("68.40.207.134")).toBe(true);
    expect(PROBE_HOST.test("::1")).toBe(true);
    expect(PROBE_HOST.test("a b")).toBe(false);
    expect(PROBE_HOST.test("-x")).toBe(false);
  });
});
