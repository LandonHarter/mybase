// No administrative credentials, network interfaces, volumes, or host paths enter this process.
import { chromium } from "playwright";
const seconds = Number(process.argv[2]);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) process.exit(2);
setTimeout(() => process.exit(0), seconds * 1000);
const browser = await chromium.launchPersistentContext("/tmp/chromium", {
  headless: true,
  chromiumSandbox: false, // gVisor is the guest/host boundary; see docs/sandboxes.md.
  proxy: { server: "http://127.0.0.1:3128" },
  args: ["--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1", "--disable-quic", "--disable-dev-shm-usage"],
});
browser.on("close", () => process.exit(0));
