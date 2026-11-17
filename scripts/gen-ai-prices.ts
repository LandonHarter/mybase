#!/usr/bin/env bun
// Regenerates apps/api/src/ai-prices.json from models.dev (MIT): the AI gateway's bundled price
// catalog. Run before each release. The API refreshes the same data daily (ai-prices.ts) unless
// MYBASE_AI_PRICES_REFRESH=off; this file is what it starts with, and what it falls back to.
import { join } from "node:path";
import { filterCatalog } from "../apps/api/src/ai-prices";

const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`models.dev answered ${res.status}`);
const catalog = filterCatalog(await res.json());
const out = join(import.meta.dir, "../apps/api/src/ai-prices.json");
await Bun.write(out, `${JSON.stringify(catalog)}\n`);
const models = Object.values(catalog.providers).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`wrote ${out}: ${Object.keys(catalog.providers).length} providers, ${models} models`);
