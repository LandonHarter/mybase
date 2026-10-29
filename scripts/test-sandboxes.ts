// Disposable infrastructure only. Never points migrations or destructive tests at the user's DB.
// bun scripts/test-sandboxes.ts (requires local dev Postgres/Garage/Valkey images)
export {};
const suffix=crypto.randomUUID().slice(0,8);
const names=[`mybase-test-sb-pg-${suffix}`,`mybase-test-sb-garage-${suffix}`,`mybase-test-sb-cache-${suffix}`];
async function docker(...args:string[]) {
  const child=Bun.spawn(["docker",...args],{stdout:"pipe",stderr:"pipe"});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code) throw new Error(`docker ${args[0]} failed: ${err}`); return out.trim();
}
const port=async(name:string,inside:number)=>Number((await docker("port",name,`${inside}/tcp`)).split(":").at(-1));
try {
  await docker("run","-d","--name",names[0]!,"--tmpfs","/var/lib/postgresql/data","-e","POSTGRES_PASSWORD=sandbox-integration-only","-e","POSTGRES_USER=mybase","-p","127.0.0.1::5432","mybase-postgres:dev");
  await docker("create","--name",names[1]!,"--tmpfs","/var/lib/garage","-e","GARAGE_RPC_SECRET="+"ab".repeat(32),"-e","GARAGE_ADMIN_TOKEN=sandbox-integration-only","-p","127.0.0.1::3900","-p","127.0.0.1::3903","dxflrs/garage:v2.4.1");
  await docker("cp","docker/sandbox-test-garage.toml",`${names[1]}:/etc/garage.toml`);
  await docker("start",names[1]!);
  await docker("run","-d","--name",names[2]!,"--tmpfs","/data","-p","127.0.0.1::6379","valkey/valkey:8.1-alpine","valkey-server","--requirepass","sandbox-integration-only","--save","","--appendonly","no");
  const env={...process.env,MYBASE_SANDBOX_INTEGRATION:"1",POSTGRES_HOST:"127.0.0.1",POSTGRES_PORT:String(await port(names[0]!,5432)),POSTGRES_USER:"mybase",POSTGRES_PASSWORD:"sandbox-integration-only",
    GARAGE_ADMIN_URL:`http://127.0.0.1:${await port(names[1]!,3903)}`,GARAGE_S3_URL:`http://127.0.0.1:${await port(names[1]!,3900)}`,GARAGE_ADMIN_TOKEN:"sandbox-integration-only",GARAGE_CAPACITY:"100M",
    VALKEY_HOST:"127.0.0.1",VALKEY_PORT:String(await port(names[2]!,6379)),VALKEY_PASSWORD:"sandbox-integration-only",MYBASE_DB_PUBLIC:"",MYBASE_ADMIN_PASSWORD:"integration-admin-password",MYBASE_SECRETS_KEY:"",MYBASE_ADMIN_RESET_MFA:"",MYBASE_SANDBOX_WORKER_KEY:"sandbox-integration-worker-key-32-characters"};
  const test=Bun.spawn(["bun","test","apps/api/src/sandbox.integration.test.ts"],{env,stdout:"inherit",stderr:"inherit"});
  const code=await test.exited;
  if(code) process.exitCode=code;
} finally { for(const name of names) await docker("rm","-f",name).catch(()=>{}); }
