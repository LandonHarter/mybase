import { expect, test } from "bun:test";
import { BadInput, containerName, parseLabels, probeHealthy, readSpec, runArgs } from "./runtime";

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
