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
    expect(createArgs(id,"project_one","trusted-image",null).at(-1)).toBe("0");
    expect(createArgs(id,"project_one","trusted-image",7200).at(-1)).toBe("7200");
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
  test("worker honors host settings and opt-in timeouts, including deadlines beyond native timer range",async()=>{
    // Isolated fake Docker transport: exercise timing/configuration without changing global Bun.spawn.
    const source=`
      const {createArgs,runExecution}=await import(${JSON.stringify(new URL("./runtime.ts",import.meta.url).href)});
      const args=createArgs(${JSON.stringify(id)},'test','image',null);
      const realSpawn=Bun.spawn;
      Bun.spawn=()=>({
        stdout:new ReadableStream({start(c){setTimeout(()=>{c.enqueue(new Uint8Array(32).fill(65));c.close()},80)}}),
        stderr:new ReadableStream({start(c){c.close()}}),
        exited:new Promise(resolve=>setTimeout(()=>resolve(0),80))
      });
      const results=[];
      for(const timeoutMs of [undefined,null,3000000000,10]){
        const stopped=[];
        const result=await new Promise(resolve=>runExecution('run',${JSON.stringify(id)},{key:'key',code:'ok',timeoutMs},resolve,state=>stopped.push(state)));
        results.push({state:result.state,stdout:result.stdout,truncated:result.truncated,stopped});
      }
      Bun.spawn=realSpawn;
      console.log(JSON.stringify({args,results}));`;
    const child=Bun.spawn([process.execPath,"--eval",source],{env:{...process.env,MYBASE_SANDBOX_CONFIG:'{"resources":{"cpus":0.5,"memoryMb":2048,"workspaceMb":256,"pids":512,"tmpMb":512,"shmMb":128},"limits":{"outputBytes":16}}'},stdout:"pipe",stderr:"pipe",timeout:3000});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(stderr).toBe("");expect(code).toBe(0);
    const data=JSON.parse(stdout);
    for(const flag of ["--cpus=0.5","--memory=2048m","--memory-swap=2048m","--pids-limit=512","--shm-size=128m"])expect(data.args).toContain(flag);
    expect(data.results.map((r:any)=>r.state)).toEqual(["success","success","success","timed_out"]);
    for(const result of data.results){expect(result.stdout).toBe("A".repeat(16));expect(result.truncated).toBe(true);}
    expect(data.results[2].stopped).toEqual([]);expect(data.results[3].stopped).toEqual(["timed_out"]);
  });
});
