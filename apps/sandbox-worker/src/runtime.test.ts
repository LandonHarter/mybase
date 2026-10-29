import { describe,expect,test } from "bun:test";
import { createArgs,bounded,containerName } from "./runtime";
import { publicDestination } from "./network";
import { publicSandboxIp } from "@mybase/shared/public-ip";
import { sandboxPath } from "@mybase/shared/sandbox";
const id = "12345678-1234-1234-1234-123456789abc";
describe("sandbox security boundary",()=>{
  test("guest specification requires gVisor, no NIC/mounts, bounded resources and no host credentials",()=>{
    const args = createArgs(id,"project_one","trusted-image",30);
    for (const flag of ["--runtime=runsc","--network=none","--read-only","--cap-drop=ALL","--security-opt=no-new-privileges:true","--cpus=1","--memory=1024m","--memory-swap=1024m","--pids-limit=256","--log-driver=none","--restart=no"]) expect(args).toContain(flag);
    expect(args).not.toContain("--volume"); expect(args).not.toContain("--mount"); expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.filter(s=>s.includes(":rw,nosuid,nodev,size="))).toHaveLength(2);
    expect(()=>containerName("--privileged")).toThrow();
  });
  test("blocks private, metadata, mapped/transition IPv6 and special addresses",()=>{
    for(const address of ["127.0.0.1","10.1.2.3","172.17.0.1","192.168.1.1","169.254.169.254","100.100.100.200","198.18.0.1","::1","::ffff:127.0.0.1","64:ff9b::7f00:1","2002:7f00:1::","2001:db8::1","fe80::1","fc00::1","3fff::1"]) expect(publicSandboxIp(address)).toBe(false);
    expect(publicSandboxIp("93.184.216.34")).toBe(true); expect(publicSandboxIp("2606:4700:4700::1111")).toBe(true);
  });
  test("pins a validated DNS answer and rejects mixed answers or infrastructure aliases",async()=>{
    let lookups = 0;
    const resolver = (async()=>{ lookups++; return [{address:"93.184.216.34",family:4}]; }) as any;
    expect(await publicDestination("public.test",443,new Set(),resolver)).toBe("93.184.216.34"); expect(lookups).toBe(1);
    const mixed = (async()=>[{address:"93.184.216.34",family:4},{address:"127.0.0.1",family:4}]) as any;
    await expect(publicDestination("mixed.test",443,new Set(),mixed)).rejects.toThrow("denied");
    await expect(publicDestination("api.test.",443,new Set(["api.test"]),resolver)).rejects.toThrow("denied");
    await expect(publicDestination("public.test",80,new Set(["93.184.216.34"]),resolver)).rejects.toThrow("denied");
    await expect(publicDestination("public.test",6379,new Set(),resolver)).rejects.toThrow("denied");
  });
  test("bounds output while draining both streams",async()=>{
    const stream = new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(100));c.enqueue(new Uint8Array(100));c.close();}});
    const result=await bounded(stream,64); expect(result.bytes.length).toBe(64); expect(result.truncated).toBe(true);
    for(const path of ["/etc/passwd","../x","a/../../b","a\\b","a/./b","a//b","a\0b"]) expect(()=>sandboxPath(path)).toThrow();
    expect(sandboxPath("photos/a.png")).toBe("photos/a.png");
  });
});
