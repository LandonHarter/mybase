import { describe, expect, test } from "bun:test";
import { createSandboxClient, MybaseApiError } from "./sandbox";

describe("sandbox SDK", () => {
  test("scopes paths, passes idempotency and binary bytes, and returns streamed artifacts", async () => {
    const calls: {url:string;init:RequestInit}[] = [];
    const client = createSandboxClient({ apiUrl:"https://mybase.test/",project:"app_one",apiKey:"mb_test",fetch:async (url,init) => {
      calls.push({url:String(url),init:init!});
      if (String(url).includes("artifacts/")) return new Response(new Uint8Array([1,2,3]));
      if (init?.method === "PUT") return new Response(null,{status:204});
      return Response.json({id:"box",state:"queued"});
    } });
    await client.create({key:"import_1"});
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({key:"import_1"});
    await client.upload("box","photos/a.png",new Uint8Array([9,8]));
    expect(calls[1]!.url).toBe("https://mybase.test/sandbox/app_one/box/files?path=photos%2Fa.png");
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer mb_test");
    expect(calls[1]!.init.body).toEqual(new Uint8Array([9,8]));
    expect(await (await client.artifact("box","photo")).bytes()).toEqual(new Uint8Array([1,2,3]));
  });
  test("browser credentials include auth in headers only", async () => {
    const client = createSandboxClient({apiUrl:"https://mybase.test",project:"app",apiKey:"mb_private",fetch:async()=>Response.json({endpoint:"wss://mybase.test/sandbox/app/box/browser",headers:{"X-Mybase-Browser-Token":"short"}})});
    const browser = await client.browser("box");
    expect(browser.headers.Authorization).toBe("Bearer mb_private");
    expect(browser.endpoint).not.toContain("private");
  });
  test("quota errors retain status; abort reaches polling", async () => {
    const client = createSandboxClient({apiUrl:"https://mybase.test",project:"app",apiKey:"mb_test",fetch:async()=>Response.json({error:"capacity"},{status:429})});
    try { await client.create({key:"x"}); throw new Error("expected failure"); } catch(err) { expect(err).toBeInstanceOf(MybaseApiError); expect((err as MybaseApiError).status).toBe(429); }
    const controller = new AbortController(); controller.abort(new Error("cancelled poll"));
    const poll = createSandboxClient({apiUrl:"https://mybase.test",project:"app",apiKey:"mb_test",fetch:async()=>Response.json({state:"queued"})});
    await expect(poll.wait("box",controller.signal)).rejects.toThrow("cancelled poll");
  });
});
