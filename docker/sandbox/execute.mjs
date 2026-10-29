// Reap ordinary background descendants on completion; host cancellation destroys the whole guest.
// Agent code and this supervisor share a guest trust domain, not a security boundary.
import { spawn } from "node:child_process";
const spec = JSON.parse(process.argv[2]);
const args = spec.code === undefined ? spec.command : ["node","--input-type=module","-e",spec.code];
const child = spawn(args[0],args.slice(1),{ cwd:"/workspace",detached:true,stdio:["ignore","inherit","inherit"] });
child.on("error",()=>process.exit(127));
child.on("exit",(code,signal)=>{
  try { process.kill(-child.pid,"SIGKILL"); } catch { /* Already empty process group. */ }
  process.exit(code ?? (signal ? 128 : 1));
});
