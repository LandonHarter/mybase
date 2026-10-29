// Run only through scripts/test-sandboxes.ts, which creates disposable infrastructure.
import { afterAll,beforeAll,describe,expect,test } from "bun:test";
import { createSandboxClient, type SandboxExecution } from "@mybase-dev/sdk/sandbox";
import { createHash } from "node:crypto";
import { SQL } from "bun";
const enabled=process.env.MYBASE_SANDBOX_INTEGRATION === "1";
describe.skipIf(!enabled)("sandbox API + durable Postgres + Garage (deterministic worker double)",()=>{
  let api: ReturnType<typeof Bun.spawn>;
  let worker: ReturnType<typeof Bun.serve>;
  let base=""; let admin=""; let tokenA=""; let tokenB=""; let readToken="";
  let boxes=new Map<string,{project:string;state:string;expiresAt:number;reason:null;files:Map<string,Uint8Array>;runs:Map<string,SandboxExecution>}>();
  async function request(path:string,method="GET",body?:unknown,token=admin) {
    return fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:body === undefined ? undefined : JSON.stringify(body)});
  }
  const client=(project="sb_one",apiKey=tokenA)=>createSandboxClient({apiUrl:base,project,apiKey});
  const launchApi=()=>api=Bun.spawn(["bun","apps/api/src/index.ts"],{env:{...process.env,API_PORT:new URL(base).port,MYBASE_PUBLIC_URL:base,MYBASE_SANDBOX_WORKER_URL:`http://127.0.0.1:${worker.port}`,LOG_LEVEL:"error"},stdout:"ignore",stderr:"inherit"});
  async function terminate(id:string){await client().terminate(id);for(let i=0;i<60;i++){if(["terminated","expired","failed"].includes((await client().get(id)).state))return;await Bun.sleep(100);}throw new Error("cleanup timed out");}
  beforeAll(async()=>{
    worker=Bun.serve({port:0,async fetch(req,server){
      if(req.headers.get("authorization")!==`Bearer ${process.env.MYBASE_SANDBOX_WORKER_KEY}`)return new Response(null,{status:401});
      const url=new URL(req.url);if(url.pathname==="/health")return Response.json({ok:true});
      const [,,id,op,runId]=url.pathname.split("/");const project=req.headers.get("x-mybase-project")!;
      let box=boxes.get(id!);
      if(!op&&req.method==="PUT"){
        if(!box){const spec=await req.json() as any;box={project,state:"ready",expiresAt:Date.now()+spec.ttlSeconds*1000,reason:null,files:new Map(),runs:new Map()};boxes.set(id!,box);}
        return Response.json(box);
      }
      if(!box||box.project!==project)return new Response(null,{status:404});
      if(op==="browser") { if(server.upgrade(req,{data:undefined})) return; return new Response(null,{status:400}); }
      if(Date.now()>=box.expiresAt)box.state="expired";
      if(!op){if(req.method==="DELETE")box.state="terminated";return Response.json(box);}
      if(op==="executions"){
        if(req.method==="PUT"){
          const spec=await req.json() as any;
          const result:SandboxExecution={id:runId!,sandboxId:id!,state:"success",exitCode:0,stdout:"fixture complete",stderr:"",truncated:false,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};
          if(spec.code==="timeout"){result.state="timed_out";result.exitCode=137;box.state="terminated";}
          if(spec.code==="pending"){result.state="running";result.finishedAt=null;}
          box.runs.set(runId!,result);return Response.json(result);
        }
        return box.runs.has(runId!)?Response.json(box.runs.get(runId!)):new Response(null,{status:404});
      }
      if(op==="files"){
        const path=url.searchParams.get("path")!;
        if(req.method==="PUT"){box.files.set(path,new Uint8Array(await req.arrayBuffer()));return new Response(null,{status:204});}
        return new Response(box.files.get(path) as BodyInit);
      }
      return new Response(null,{status:404});
    },websocket:{message(ws,message){ws.send(message);}}});
    const reserve=Bun.serve({port:0,fetch:()=>new Response()});const port=reserve.port;reserve.stop(true);base=`http://127.0.0.1:${port}`;
    launchApi();
    let ready=false;for(let i=0;i<200;i++){try{if((await fetch(base+"/health")).ok){ready=true;break;}}catch{}await Bun.sleep(200);}
    if(!ready)throw new Error("test API failed to start");
    admin=(await (await request("/auth/login","POST",{username:"admin",password:"integration-admin-password",tokenName:"test"})).json() as any).token;
    expect(admin).toBeString();
    for(const name of ["sb_one","sb_two"]){expect((await request("/projects","POST",{name})).status).toBe(201);expect((await request(`/projects/${name}/services/sandbox`,"PUT",{})).status).toBe(204);}
    const make=async(project:string,permission:string)=>{const response=await request("/auth/tokens","POST",{name:`${project}-${permission}`,permissions:[permission],projects:[project]});expect(response.status).toBe(201);return (await response.json() as any).token;};
    tokenA=await make("sb_one","sandbox:write");tokenB=await make("sb_two","sandbox:write");readToken=await make("sb_one","sandbox:read");
  },60000);
  afterAll(async()=>{api?.kill("SIGTERM");if(api)await api.exited;worker?.stop(true);});
  test("prompt admission, lifecycle, idempotency, capacity and project isolation",async()=>{
    const c=client();const admitted=await Promise.all(Array.from({length:8},()=>c.create({key:"admit",ttlSeconds:60})));const box=admitted[0]!;
    expect(new Set(admitted.map(box=>box.id)).size).toBe(1);
    expect((await c.create({key:"admit",ttlSeconds:60})).id).toBe(box.id);
    expect((await request("/sandbox/sb_one","POST",{key:"admit",ttlSeconds:61},tokenA)).status).toBe(409);
    expect((await request("/sandbox/sb_one","POST",{key:"second"},tokenA)).status).toBe(429);
    expect((await request(`/sandbox/sb_one/${box.id}`,"GET",undefined,tokenB)).status).toBe(403);
    expect((await request(`/sandbox/sb_two/${box.id}`,"GET",undefined,tokenB)).status).toBe(404);
    expect((await c.wait(box.id)).state).toBe("ready");
    const runs=await Promise.all(Array.from({length:8},()=>c.execute(box.id,{key:"run",code:"ok"})));const run=runs[0]!;
    expect(new Set(runs.map(run=>run.id)).size).toBe(1);
    expect((await c.execute(box.id,{key:"run",code:"ok"})).id).toBe(run.id);
    expect((await c.waitExecution(box.id,run.id)).state).toBe("success");
    await terminate(box.id);expect((await c.get(box.id)).runtimeMs).toBeGreaterThan(0);
  },20000);
  test("private artifacts preserve checksum, bytes and authorization after guest cleanup",async()=>{
    const c=client();const box=await c.create({key:"artifacts",ttlSeconds:60});await c.wait(box.id);
    const bytes=new Uint8Array([137,80,78,71,0,1,2]);await c.upload(box.id,"image.png",bytes);
    const artifact=await c.exportArtifact(box.id,"image.png","image/png");
    expect((await c.exportArtifact(box.id,"image.png","image/png")).id).toBe(artifact.id);
    expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));expect(artifact.project).toBe("sb_one");
    expect(await (await c.artifact(box.id,artifact.id)).bytes()).toEqual(bytes);
    expect((await request(`/sandbox/sb_one/${box.id}/artifacts/${artifact.id}`,"GET",undefined,tokenB)).status).toBe(403);
    expect((await request(`/sandbox/sb_two/${box.id}/artifacts/${artifact.id}`,"GET",undefined,tokenB)).status).toBe(404);
    expect((await request(`/sandbox/sb_one/${box.id}/browser`,"POST",{},readToken)).status).toBe(403);
    const connection=await c.browser(box.id);expect(connection.endpoint).not.toContain(connection.headers["X-Mybase-Browser-Token"]!);
    await terminate(box.id);expect(await (await c.artifact(box.id,artifact.id)).bytes()).toEqual(bytes);
  },20000);
  test("CDP requires normal project write auth plus single-use scoped browser credential",async()=>{
    const c=client();const box=await c.create({key:"cdp",ttlSeconds:60});await c.wait(box.id);
    const connection=await c.browser(box.id);
    expect((await request(`/sandbox/sb_one/${box.id}/browser`,"GET",undefined,readToken)).status).toBe(403);
    const WithHeaders=WebSocket as unknown as new(url:string,options:{headers:Record<string,string>})=>WebSocket;
    const ws=new WithHeaders(connection.endpoint,{headers:connection.headers});
    await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error("CDP failed to connect"));});
    const response=new Promise<string>(resolve=>{ws.onmessage=e=>resolve(String(e.data));});
    ws.send('{"id":1,"method":"Browser.getVersion"}');
    expect(await response).toBe('{"id":1,"method":"Browser.getVersion"}');
    ws.close();
    expect((await fetch(base+`/sandbox/sb_one/${box.id}/browser`,{headers:connection.headers})).status).toBe(404);
    const expired=await c.browser(box.id);
    await Bun.sleep(31_000);
    expect((await fetch(base+`/sandbox/sb_one/${box.id}/browser`,{headers:expired.headers})).status).toBe(404);
    await terminate(box.id);
  },40000);
  test("cancellation stops guest and never dispatches another command",async()=>{
    const c=client();const box=await c.create({key:"cancel",ttlSeconds:60});await c.wait(box.id);
    const run=await c.execute(box.id,{key:"pending",code:"pending"});
    expect((await c.cancel(box.id,run.id)).state).toBe("cancelled");
    await terminate(box.id);expect((await c.execution(box.id,run.id)).state).toBe("cancelled");
    expect((await request(`/sandbox/sb_one/${box.id}/executions`,"POST",{key:"late",code:"ok"},tokenA)).status).toBe(409);
  },20000);
  test("timeout output harvested before terminal state; worker loss fails unknown work",async()=>{
    const c=client();const box=await c.create({key:"timeout",ttlSeconds:60});await c.wait(box.id);
    const run=await c.execute(box.id,{key:"timeout",code:"timeout"});expect((await c.waitExecution(box.id,run.id)).state).toBe("timed_out");await terminate(box.id);
    const next=await c.create({key:"lost",ttlSeconds:60});await c.wait(next.id);boxes.delete(next.id);
    for(let i=0;i<40;i++){if((await c.get(next.id)).state==="failed")break;await Bun.sleep(100);}
    expect((await c.get(next.id)).state).toBe("failed");
  },20000);
  test("TTL expiration cleans up and usage counts reserved allocation",async()=>{
    const c=client();const box=await c.create({key:"ttl",ttlSeconds:10});await c.wait(box.id);
    for(let i=0;i<130;i++){if((await c.get(box.id)).state==="expired")break;await Bun.sleep(100);}
    expect((await c.get(box.id)).state).toBe("expired");expect(boxes.get(box.id)?.state).toBe("terminated");
    const usage=await c.usage();expect(usage.active).toBe(0);expect(usage.allocatedSecondsToday).toBeGreaterThan(200);expect(usage.artifactBytesToday).toBe(7);
  },20000);
  test("expired artifacts are denied immediately; restart cleans pending exports and releases reservation",async()=>{
    const db=new SQL({hostname:process.env.POSTGRES_HOST,port:Number(process.env.POSTGRES_PORT),username:"mybase",password:process.env.POSTGRES_PASSWORD,database:"postgres"});
    try{
      const [artifact]=await db`select * from mybase.sandbox_artifacts where project='sb_one' limit 1`;
      const storage=`/projects/sb_one/files?prefix=${encodeURIComponent(`_mybase/sandboxes/${artifact.sandbox_id}/`)}`;
      expect((await (await request(storage)).json() as any).files.length).toBe(1);
      await db`update mybase.sandbox_artifacts set expires_at=now()-interval '1 second' where id=${artifact.id}`;
      expect((await request(`/sandbox/sb_one/${artifact.sandbox_id}/artifacts/${artifact.id}`,"GET",undefined,tokenA)).status).toBe(404);
      // Model a crash after object upload but before the pending->ready commit.
      await db`update mybase.sandbox_artifacts set state='pending',created_at=now()-interval '6 minutes' where id=${artifact.id}`;
      api.kill("SIGTERM");await api.exited;launchApi();
      let cleaned=false;
      for(let i=0;i<100;i++){
        try{const res=await request(storage);if(res.ok&&(await res.json() as any).files.length===0){cleaned=true;break;}}catch{}
        await Bun.sleep(100);
      }
      expect(cleaned).toBe(true);expect((await db`select * from mybase.sandbox_artifacts where project='sb_one'`).length).toBe(0);
      expect((await client().usage()).artifactBytesToday).toBe(0);
      expect((await request("/projects/sb_one/services/sandbox","DELETE")).status).toBe(204);
      expect((await request("/sandbox/sb_one","GET",undefined,tokenA)).status).toBe(404);
    }finally{await db.close();}
  },30000);
});
