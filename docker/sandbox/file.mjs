import { constants } from "node:fs";
import { open, realpath, mkdir } from "node:fs/promises";
import path from "node:path";
const [mode, relative] = process.argv.slice(2);
if (!relative || relative.startsWith("/") || relative.split("/").some(p => !p || p === "." || p === "..") || /[\x00-\x1f\\]/.test(relative)) process.exit(2);
const target = path.join("/workspace", relative);
if (mode === "write") await mkdir(path.dirname(target), { recursive: true });
const parent = await realpath(path.dirname(target));
if (parent !== "/workspace" && !parent.startsWith("/workspace/")) process.exit(2);
const handle = await open(target, constants.O_NOFOLLOW | constants.O_NONBLOCK | (mode === "write" ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC : constants.O_RDONLY), 0o600);
try {
  if (!(await handle.stat()).isFile()) process.exit(2);
  if (mode === "read") {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 8388608) process.exit(2);
    const bytes = Buffer.alloc(8388609);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8388608) process.exit(2);
    process.stdout.write(bytes.subarray(0, bytesRead));
  } else {
    let count = 0;
    for await (const chunk of process.stdin) {
      count += chunk.length;
      if (count > 8388608) process.exit(2);
      await handle.write(chunk);
    }
  }
} finally { await handle.close(); }
