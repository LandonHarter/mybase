import { describe,expect,test } from "bun:test";
import { allows,requirement } from "./permissions";
import { executionSpec,readBoundedBody } from "./sandbox";
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
  test("execution validation bounds command, code and timeout",()=>{
    expect(executionSpec({key:"one",code:"console.log(1)"}).timeoutMs).toBe(30000);
    for(const input of [{key:"x"},{key:"x",code:"x",command:["node"]},{key:"x",code:"x",timeoutMs:0},{key:"x",code:"x",timeoutMs:120001},{key:"x",command:[]},{key:"x",command:["a\0b"]},{key:"x",code:"x".repeat(65537)}]) expect(()=>executionSpec(input as any)).toThrow();
  });
  test("streamed uploads cannot evade byte bounds with missing content-length",async()=>{
    const req=new Request("http://test",{method:"PUT",body:new ReadableStream({start(c){c.enqueue(new Uint8Array(9));c.close();}}),duplex:"half"} as RequestInit);
    await expect(readBoundedBody(req,8)).rejects.toThrow("transfer limit");
  });
});
