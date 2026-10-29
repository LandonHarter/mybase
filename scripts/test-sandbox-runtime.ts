// Hardened worker/runtime integration: requires runsc, cgroup v2 and mybase-sandbox:local.
// --fixture-only exercises TRUSTED browser fixture under runc when runsc isn't installed;
// it never claims to verify hostile-code isolation and never enables a production fallback.
import { strict as assert } from "node:assert";
import { createArgs, docker } from "../apps/sandbox-worker/src/runtime";
import { startEgress } from "../apps/sandbox-worker/src/network";
import { createConnection,createServer,type AddressInfo } from "node:net";
import { createLogger } from "@mybase/shared/logger";
import { probeBrowser, stopTestWorker } from "./sandbox-test-helpers";
const log = createLogger("sandbox");
const fixtureOnly=process.argv.includes("--fixture-only");
log.info("sandbox runtime test started", { fixtureOnly });
const source=await Bun.file(new URL("../examples/sandbox/listing.mjs",import.meta.url)).text();
const code=`const listingUrl='https://sandbox-fixture.invalid/listing'; const fixture=true;\n${source}`;
async function execInput(args:string[],input:string){
  const child=Bun.spawn(["docker",...args],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});child.stdin.write(input);child.stdin.end();
  const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  assert.equal(status,0,err);return out;
}
if(fixtureOnly){
  const id=crypto.randomUUID();const name=`mybase-sandbox-${id}`;
  try{
    // runc's RLIMIT_NPROC counts this host user's unrelated tasks; gVisor has its own guest UID space.
    // Fixture-only deliberately tests browser functionality, not production resource/isolation controls.
    const args=createArgs(id,"fixture","mybase-sandbox:local",null).filter(arg=>arg!=="--runtime=runsc"&&arg!=="mybase.sandbox=true"&&!arg.startsWith("--ulimit=nproc="));
    // Remove the label option whose value was removed; fixture must not overlap worker-owned guests.
    const label=args.indexOf("--label");args.splice(label,1);
    await docker(args);
    let ready=false;for(let i=0;i<50;i++){try{await docker(["exec",name,"node","-e","fetch('http://127.0.0.1:9222/json/version').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]);ready=true;break;}catch{await Bun.sleep(200);}}
    assert(ready,"Chromium didn't become ready");
    const out=(await docker(["exec",name,"node","/opt/runtime/execute.mjs",JSON.stringify({code})])).toString();
    const manifest=JSON.parse(out.trim().split("\n").at(-1)!);assert.equal(manifest.diagnostics.length,0);assert(manifest.photos.length>0);
    const evidence=JSON.parse((await docker(["exec",name,"node","/opt/runtime/file.mjs","read","evidence.json"])).toString());
    assert(evidence.text.includes("bedrooms"));assert(evidence.responses.some((r:any)=>r.json.bedrooms===3));
    const image=await docker(["exec",name,"node","/opt/runtime/file.mjs","read",manifest.photos[0].path]);assert.equal(image.subarray(0,4).toString("hex"),"89504e47");
    await execInput(["exec","-i",name,"node","/opt/runtime/file.mjs","write","roundtrip.txt"],"workspace roundtrip");
    assert.equal((await docker(["exec",name,"node","/opt/runtime/file.mjs","read","roundtrip.txt"])).toString(),"workspace roundtrip");
    // A host-selected file cap must pass through the helper; the old hardcoded 8 MiB must not win.
    await docker(["exec",name,"node","-e","require('fs').writeFileSync('/workspace/large.bin',Buffer.alloc(9*1024*1024,7))"]);
    await assert.rejects(()=>docker(["exec",name,"node","/opt/runtime/file.mjs","read","large.bin"]));
    const large=await docker(["exec",name,"node","/opt/runtime/file.mjs","read","large.bin",String(16*1024*1024)],undefined,16*1024*1024);
    assert.equal(large.length,9*1024*1024);assert(large.every(value=>value===7));
    await docker(["exec",name,"node","-e","require('fs').symlinkSync('/etc/passwd','/workspace/escape')"]);
    await assert.rejects(()=>docker(["exec",name,"node","/opt/runtime/file.mjs","read","escape"]));
    await assert.rejects(()=>docker(["exec",name,"node","/opt/runtime/execute.mjs",JSON.stringify({command:["/bin/sh","-c","kill -KILL $$"]})]),/exit 137/);
    // Exercise real Docker stdio relay against a deterministic TCP fixture. Only this test injects
    // a dialer to map an already-validated public IP to our local fixture; production has no override.
    const upstream=createServer(socket=>socket.on("data",bytes=>{
      if(bytes.toString().startsWith("GET / ")) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nrelay-fixture");
      else if(bytes.toString()==="ping")socket.end("pong");
    }));
    await new Promise<void>(resolve=>upstream.listen(0,"127.0.0.1",resolve));
    let connections=0;let failed=false;
    const stopRelay=startEgress(name,new Set(["denied.fixture"]),()=>{failed=true;},{
      resolve:(async(host:string)=>{if(host==="mixed.fixture")return[{address:"93.184.216.34",family:4},{address:"127.0.0.1",family:4}];if(host!=="public.fixture")throw new Error("fixture DNS denied");return[{address:"93.184.216.34",family:4}];})as any,
      connect:((options:any)=>{assert.equal(options.host,"93.184.216.34");connections++;return createConnection({...options,host:"127.0.0.1",port:(upstream.address()as AddressInfo).port});})as typeof createConnection,
    });
    try{
      await Bun.sleep(300);
      const probe=`import net from 'node:net';
        async function request(host,connect=true){return new Promise((resolve,reject)=>{
          const socket=net.connect(3128,'127.0.0.1',()=>socket.write(connect?'CONNECT '+host+':443 HTTP/1.1\\r\\n\\r\\n':'GET http://'+host+'/ HTTP/1.1\\r\\nHost: '+host+'\\r\\nConnection: close\\r\\n\\r\\n'));
          let data='';let sent=false;socket.setTimeout(3000,()=>{socket.destroy();reject(new Error('proxy timeout'))});
          socket.on('data',chunk=>{data+=chunk;if(connect&&!sent&&data.includes('200 Connection Established')){sent=true;socket.write('ping')}});
          socket.on('error',reject);socket.on('close',()=>resolve(data));
        });}
        const http=await request('public.fixture',false);if(!http.includes('relay-fixture'))throw new Error('HTTP relay failed: '+http);
        const tunnel=await request('public.fixture');if(!tunnel.includes('pong'))throw new Error('CONNECT relay failed: '+tunnel);
        for(const host of ['169.254.169.254','10.0.0.1','[::ffff:127.0.0.1]','mixed.fixture','denied.fixture']){if(await request(host))throw new Error('private destination reached: '+host)};
        console.log('relay checks passed');`;
      const result=await docker(["exec",name,"node","/opt/runtime/execute.mjs",JSON.stringify({code:probe})]);
      assert(result.toString().includes("relay checks passed"));assert(!failed);assert.equal(connections,2);
    }finally{stopRelay();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
    console.log("PASS: trusted Chromium fixture, dynamic JSON/gallery/photo bytes, artifacts, workspace/symlink checks, real stdio HTTP/CONNECT relay and private/mixed-DNS denial. gVisor isolation NOT tested (--fixture-only).");
  }finally{await docker(["rm","-f",name]).catch(()=>{});}
}else{
  const reserve=Bun.serve({port:0,fetch:()=>new Response()});const port=reserve.port;reserve.stop(true);
  const secret=crypto.randomUUID();const base=`http://127.0.0.1:${port}`;
  log.info("starting sandbox worker", { port });
  const worker=Bun.spawn(["bun","apps/sandbox-worker/src/index.ts"],{env:{...process.env,MYBASE_SANDBOX_WORKER_BIND:"127.0.0.1",MYBASE_SANDBOX_WORKER_PORT:String(port),MYBASE_SANDBOX_WORKER_KEY:secret,MYBASE_SANDBOX_IMAGE:"mybase-sandbox:local",MYBASE_SANDBOX_DENY_HOSTS:"localhost,127.0.0.1"},stdout:"inherit",stderr:"inherit"});
  async function call(path:string,method="GET",body?:unknown,project="test_project"){
    const timeoutMs = method === "PUT" && /^\/boxes\/[^/]+$/.test(path) ? 90_000 : 5000;
    return fetch(base+path,{method,headers:{Authorization:`Bearer ${secret}`,"x-mybase-project":project},body:body instanceof Uint8Array?body as BodyInit:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  }
  const ids:string[]=[];
  try{
    let healthy=false;for(let i=0;i<100;i++){try{if((await call("/health")).ok){healthy=true;break;}}catch{}if(worker.exitCode!==null)break;await Bun.sleep(100);}
    assert(healthy,"worker did not start; install runsc and cgroup v2 (or use --fixture-only for browser-image checks)");
    const create=async(ttl=120)=>{const id=crypto.randomUUID();ids.push(id);const res=await call(`/boxes/${id}`,"PUT",{ttlSeconds:ttl,idleSeconds:10});assert.equal(res.status,200,await res.clone().text());assert.equal((await res.json() as any).state,"ready");return id;};
    const run=async(id:string,input:any)=>{const exec=crypto.randomUUID();const res=await call(`/boxes/${id}/executions/${exec}`,"PUT",{key:exec,...input});assert.equal(res.status,202,await res.clone().text());return exec;};
    const wait=async(id:string,execution:string)=>{const deadline=Date.now()+35_000;while(Date.now()<deadline){const res=await call(`/boxes/${id}/executions/${execution}`);assert.equal(res.status,200);const data=await res.json() as any;if(data.finishedAt)return data;await Bun.sleep(100);}throw new Error("execution wait timed out");};
    const id=await create();
    log.info("checking sandbox project isolation");
    assert.equal((await call(`/boxes/${id}`,"GET",undefined,"other_project")).status,404);
    log.info("running Chromium fixture");
    const fixture=await run(id,{code,timeoutMs:30000});assert.equal((await wait(id,fixture)).state,"success");
    log.info("reading fixture manifest");
    const manifest=await (await call(`/boxes/${id}/files?path=manifest.json`)).json() as any;assert.equal(manifest.diagnostics.length,0);assert(manifest.photos.length);
    log.info("connecting browser CDP");
    const product=await probeBrowser(`${base.replace(/^http/,"ws")}/boxes/${id}/browser`,{Authorization:`Bearer ${secret}`,"x-mybase-project":"test_project"});
    assert(product.includes("Chrome"));await Bun.sleep(100);
    log.info("checking private and raw-network denial");
    // All private destinations fail through the ONLY egress path; raw sockets have no route.
    const network=await run(id,{code:`import net from 'node:net';
      const denied = await new Promise(r=>{const s=net.connect(3128,'127.0.0.1',()=>s.write('CONNECT 169.254.169.254:443 HTTP/1.1\\r\\n\\r\\n'));s.on('close',()=>r(true));s.on('data',()=>r(false));s.on('error',()=>r(true));});
      if(!denied)process.exit(2);
      const raw=await new Promise(r=>{const s=net.connect({host:'1.1.1.1',port:80,timeout:500});s.on('connect',()=>r(false));s.on('error',()=>r(true));s.on('timeout',()=>{s.destroy();r(true)});});if(!raw)process.exit(3);`,timeoutMs:3000});assert.equal((await wait(id,network)).state,"success");
    log.info("checking execution timeout and serialization");
    const pending=await run(id,{code:"setInterval(()=>{},1000)",timeoutMs:1000});
    assert.equal((await call(`/boxes/${id}/files?path=manifest.json`)).status,409);
    assert.equal((await wait(id,pending)).state,"timed_out");
    log.info("checking execution cancellation");
    const cancel=await create();const active=await run(cancel,{code:"setInterval(()=>{},1000)",timeoutMs:10000});assert.equal((await call(`/boxes/${cancel}/executions/${active}`,"DELETE")).status,200);
    await assert.rejects(()=>docker(["inspect",`mybase-sandbox-${cancel}`]));
    log.info("checking sandbox TTL expiration");
    const idle=await create(10);await Bun.sleep(11500);assert.equal((await (await call(`/boxes/${idle}`)).json() as any).state,"expired");
    const waitStopped=async(id:string)=>{for(let i=0;i<100;i++){const data=await(await call(`/boxes/${id}`)).json()as any;if(["failed","expired","terminated"].includes(data.state))return data;await Bun.sleep(200);}throw new Error("resource cleanup timed out");};
    log.info("checking workspace disk limit");
    const disk=await create();await run(disk,{code:"import fs from 'node:fs';fs.writeFileSync('/workspace/full',Buffer.alloc(128*1024*1024,1));setInterval(()=>{},1000)",timeoutMs:15000});
    assert.equal((await waitStopped(disk)).state,"failed");
    log.info("checking sandbox memory limit");
    const memory=await create();await run(memory,{code:"const buffers=[];setInterval(()=>buffers.push(Buffer.alloc(64*1024*1024,1)),10)",timeoutMs:15000});
    assert.equal((await waitStopped(memory)).state,"failed");
    log.info("checking sandbox process limit");
    const pids=await create();await run(pids,{code:"import{spawn}from'node:child_process';for(let i=0;i<300;i++){spawn('/bin/sleep',['60'],{stdio:'ignore'}).on('error',()=>{})}setInterval(()=>{},1000)",timeoutMs:15000});
    assert.equal((await waitStopped(pids)).state,"failed");
    log.info("checking orphan recovery after worker crash");
    const orphan=await create();worker.kill("SIGKILL");await worker.exited;
    // Restart must prune worker-labelled orphans. Start another worker for the same daemon.
    const replacement=Bun.spawn(["bun","apps/sandbox-worker/src/index.ts"],{env:{...process.env,MYBASE_SANDBOX_WORKER_PORT:String(port),MYBASE_SANDBOX_WORKER_KEY:secret,MYBASE_SANDBOX_IMAGE:"mybase-sandbox:local",MYBASE_SANDBOX_DENY_HOSTS:"localhost"},stdout:"inherit",stderr:"inherit"});
    try{await Bun.sleep(3000);await assert.rejects(()=>docker(["inspect",`mybase-sandbox-${orphan}`]));}finally{await stopTestWorker(replacement);}
    console.log("PASS: gVisor worker, Chromium fixture/CDP, project isolation, private/raw egress denial, serialization, timeout/cancel, disk/memory limits, TTL and restart orphan cleanup.");
  }finally{log.info("cleaning up sandbox runtime tests");await stopTestWorker(worker);for(const id of ids)await docker(["rm","-f",`mybase-sandbox-${id}`]).catch(()=>{});}
}
