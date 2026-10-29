// Example importer policy belongs to touse/the calling app, never the mybase service.
// Runner prepends `const listingUrl = ...; const fixture = ...;`.
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = await context.newPage();
const diagnostics = [];
const responses = [];
const photos = [];
const pending = [];
let text = "";
let structured = [];
let totalBytes = 0;
let photoSequence = 0;
let navigated = false;
const diagnose = (code,detail) => diagnostics.push({ code,detail });
if (fixture) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WQAAAABJRU5ErkJggg==","base64");
  await page.route("https://sandbox-fixture.invalid/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/photo.png") return route.fulfill({ contentType:"image/png",body:png });
    if (pathname === "/details.json") return route.fulfill({ json:{ bedrooms:3,bathrooms:2,rent:2400,photos:["/photo.png"] } });
    return route.fulfill({ contentType:"text/html",body:`<!doctype html><title>Controlled rental listing</title>
      <h1>Fixture house</h1><button id="details">Expand details</button><section id="info" hidden></section>
      <button id="gallery">Open gallery</button><div id="photos" hidden><img src="/photo.png" alt="Living room"></div>
      <script type="application/ld+json">{"@type":"House","name":"Fixture house"}</script>
      <script>details.onclick=async()=>{info.hidden=false;info.textContent=JSON.stringify(await(await fetch('/details.json')).json())};
      gallery.onclick=()=>{photos.hidden=false};</script>` });
  });
}
page.on("response", response => {
  if (pending.length >= 30) return;
  const type = response.headers()["content-type"] ?? "";
  if (!type.includes("json") && !type.startsWith("image/")) return;
  pending.push((async () => {
    try {
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const body = await response.body();
      if (body.length > 8*1024*1024 || totalBytes+body.length > 20*1024*1024) throw new Error("capture byte limit");
      totalBytes += body.length;
      if (type.includes("json")) responses.push({ url:response.url(),status:response.status(),json:JSON.parse(body.toString()) });
      else {
        const path = `photo-${photoSequence++}.bin`;
        await writeFile(path,body);
        photos.push({ path,url:response.url(),type,bytes:body.length });
      }
    } catch (error) { diagnose(type.startsWith("image/") ? "image_download_failure" : "response_read_failure",{ url:response.url(),message:String(error) }); }
  })());
});
try {
  const response = await page.goto(listingUrl,{ waitUntil:"domcontentloaded",timeout:15000 });
  navigated = true;
  text = await page.locator("body").innerText();
  if ([401,403,429].includes(response?.status()) || /captcha|verify you are human|access denied|unusual traffic/i.test(text)) {
    diagnose("page_blocked_or_challenged",{ status:response?.status(),title:await page.title() });
  } else {
    const details = page.getByRole("button",{ name:/expand details|show more|see more/i }).first();
    if (await details.count()) {
      try { await details.click({ timeout:3000 }); }
      catch (error) { diagnose("details_expansion_failure",{ message:String(error) }); }
    }
    const gallery = page.getByRole("button",{ name:/open gallery|photos|gallery/i }).first();
    if (await gallery.count()) {
      try { await gallery.click({ timeout:3000 }); }
      catch (error) { diagnose("gallery_discovery_failure",{ message:String(error) }); }
    }
    else diagnose("gallery_discovery_failure",{ message:"No known gallery control; agent should inspect DOM and choose another action." });
    await page.mouse.wheel(0,600);
    await page.waitForTimeout(300);
    text = await page.locator("body").innerText();
    structured = await page.locator('script[type="application/ld+json"]').allTextContents();
    if (!structured.length && !/bed|bath|rent/i.test(text)) diagnose("content_loaded_information_absent",{ message:"Expected fields absent from rendered evidence." });
  }
} catch (error) { diagnose(navigated ? "content_interaction_failure" : "navigation_failure",{ message:String(error) }); }
await Promise.allSettled(pending);
let candidates = [];
try { candidates = await page.locator("img").evaluateAll(images => images.map(img => ({ url:img.currentSrc || img.src,alt:img.alt,width:img.naturalWidth,height:img.naturalHeight }))); }
catch (error) { diagnose("content_inspection_failure",{ message:String(error) }); }
if (navigated && !candidates.length) diagnose("gallery_discovery_failure",{ message:"No image candidates found in rendered content." });
if (!photos.length && candidates.length) diagnose("image_download_failure",{ message:"Image candidates discovered, but no response bytes captured." });
const screenshotFiles = [];
try { await page.screenshot({ path:"screenshot.png",fullPage:true }); screenshotFiles.push({ path:"screenshot.png",type:"image/png" }); }
catch (error) { diagnose("screenshot_failure",{ message:String(error) }); }
const evidence = { url:page.url(),text,structured,responses,candidates,diagnostics };
await writeFile("evidence.json",JSON.stringify(evidence,null,2));
const manifest = { diagnostics,photos,files:[{ path:"evidence.json",type:"application/json" },...screenshotFiles,...photos.map(photo => ({ path:photo.path,type:photo.type.split(";")[0] }))] };
await writeFile("manifest.json",JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest));
await page.close().catch(()=>{});
await browser.close().catch(()=>{});
