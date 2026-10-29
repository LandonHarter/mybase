import { constants } from "node:fs";
import { open, realpath, mkdir } from "node:fs/promises";
import path from "node:path";
const [mode, relative, configuredMax] = process.argv.slice(2);
const max = Number(configuredMax ?? 8388608);
if (!Number.isSafeInteger(max) || max < 1) process.exit(2);
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
    if (!info.isFile() || info.size > max) process.exit(2);
    const bytes = Buffer.alloc(Math.min(max + 1, 65536));
    let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > max) process.exit(2);
      if (!process.stdout.write(Buffer.from(bytes.subarray(0, bytesRead)))) await new Promise(resolve => process.stdout.once("drain", resolve));
    }
  } else {
    let count = 0;
    for await (const chunk of process.stdin) {
      count += chunk.length;
      if (count > max) process.exit(2);
      await handle.write(chunk);
    }
  }
} finally { await handle.close(); }
