import { describe,expect,test } from "bun:test";
import { allows,requirement } from "./permissions";
import { executionSpec,readBoundedBody } from "./sandbox";
import { sandboxConfig, sandboxDuration } from "@mybase/shared/sandbox";
describe("sandbox admission and authorization",()=>{
  test("browser upgrade is write-only and project limited",()=>{
    const read={permissions:["sandbox:read"] as const,projects:["one"],environments:null};
    const write={...read,permissions:["sandbox:write"] as const};
    const route=requirement("GET","/sandbox/one/id/browser");
    expect(route).toEqual({resource:"sandbox",level:"write"});
    expect(allows(read,route,"one")).toBe(false); expect(allows(write,route,"one")).toBe(true); expect(allows(write,route,"two")).toBe(false);
    for(const path of ["/sandbox/one/id","/sandbox/one/id/files","/sandbox/one/id/artifacts/art","/sandbox/one/id/executions/run"]) {
      expect(allows(read,requirement("GET",path),"two")).toBe(false);
      expect(requirement("GET",path)).toEqual({resource:"sandbox",level:"read"});
    }
  });
  test("deadlines are opt-in and accept durations beyond former ceilings without timer overflow",()=>{
    expect(executionSpec({key:"one",code:"console.log(1)"}).timeoutMs).toBeNull();
    expect(executionSpec({key:"one",code:"x",timeoutMs:null}).timeoutMs).toBeNull();
    expect(executionSpec({key:"one",code:"x",timeoutMs:3_000_000_000}).timeoutMs).toBe(3_000_000_000);
    expect(sandboxDuration(undefined)).toBeNull(); expect(sandboxDuration(null)).toBeNull();
    expect(sandboxDuration(7200)).toBe(7200);
    for (const value of [0,-1,1.5,Infinity,NaN,"60",Number.MAX_SAFE_INTEGER]) expect(()=>sandboxDuration(value)).toThrow();
    for(const input of [{key:"x"},{key:"x",code:"x",command:["node"]},{key:"x",code:"x",timeoutMs:0},{key:"x",command:[]},{key:"x",command:["a\0b"]},{key:"x",code:"x".repeat(65537)}]) expect(()=>executionSpec(input as any)).toThrow();
  });
  test("host resource settings are positive, explicit, and reject misspellings",()=>{
    const config=sandboxConfig('{"resources":{"cpus":0.5,"memoryMb":2048,"pids":512},"limits":{"fileBytes":16777216,"networkStreams":64}}');
    expect(config.resources.cpus).toBe(0.5);expect(config.resources.memoryMb).toBe(2048);expect(config.resources.pids).toBe(512);
    expect(config.limits.fileBytes).toBe(16777216);expect(config.limits.networkStreams).toBe(64);
    expect(sandboxConfig().resources.memoryMb).toBe(1024);
    for(const value of ['[]','null','{"workers":2}','{"resources":{"memoryMb":0}}','{"limits":{"fileBytes":-1}}','{"resources":{"pids":1.5}}','{"limits":{"fileByte":8}}']) expect(()=>sandboxConfig(value)).toThrow();
  });
  test("streamed uploads cannot evade byte bounds with missing content-length",async()=>{
    const req=new Request("http://test",{method:"PUT",body:new ReadableStream({start(c){c.enqueue(new Uint8Array(9));c.close();}}),duplex:"half"} as RequestInit);
    await expect(readBoundedBody(req,8)).rejects.toThrow("transfer limit");
  });
});
