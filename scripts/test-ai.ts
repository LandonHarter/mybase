#!/usr/bin/env bun
// AI suite integration test, on disposable infrastructure only (never the dev database):
// throwaway Postgres/Garage/Valkey containers, a fake OpenAI-compatible + Anthropic server, and
// the API itself on a free port. Exercises the gateway (stream, non-stream, translation,
// fallbacks, budgets, cache, capture, native passthrough, images), vector sources, and memory.
//   bun scripts/test-ai.ts      (needs Docker and the mybase-postgres:dev image)
export {};

const suffix = crypto.randomUUID().slice(0, 8);
const names = [`mybase-test-ai-pg-${suffix}`, `mybase-test-ai-garage-${suffix}`, `mybase-test-ai-cache-${suffix}`];

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`docker ${args[0]} failed: ${err}`);
  return out.trim();
}
const port = async (name: string, inside: number) => Number((await docker("port", name, `${inside}/tcp`)).split(":").at(-1));

// ---- fake providers -----------------------------------------------------------

const DIMS = 8;
const vectorOf = (text: string, dims = DIMS) => {
  const v = Array.from({ length: dims }, (_, i) => {
    let h = 0;
    for (const ch of `${i}:${text.toLowerCase()}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return (h % 1000) / 1000;
  });
  return v;
};
const headersOf = (h: Headers) => {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
};
const sseOut = (events: unknown[]) => events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`)).join("");
const seen: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];

function chatAnswer(body: Record<string, unknown>): string {
  const format = body.response_format as { json_schema?: { name?: string } } | undefined;
  const messages = body.messages as { role: string; content: string }[];
  const last = messages.at(-1)?.content ?? "";
  if (format?.json_schema?.name === "facts") {
    const facts = last.split("\n").flatMap((l) =>
      l.startsWith("user: ")
        ? l
            .slice(6)
            .split(" and ")
            .map((s) => s.trim())
        : [],
    );
    return JSON.stringify({ facts });
  }
  if (format?.json_schema?.name === "memory_decisions") {
    const existing = JSON.parse(/Existing memories:\n(.*)\n/.exec(last)![1]!) as { id: string; text: string }[];
    const facts = JSON.parse(/New facts:\n(.*)\n/.exec(last)![1]!) as string[];
    let next = existing.length;
    return JSON.stringify({
      memory: facts.map((f) => {
        const same = existing.find((e) => e.text.toLowerCase() === f.toLowerCase());
        if (same) return { id: same.id, text: f, event: "NONE" };
        const moved = existing.find((e) => e.text.startsWith("Lives in") && f.startsWith("Lives in"));
        if (moved) return { id: moved.id, text: f, event: "UPDATE", old_memory: moved.text };
        return { id: String(next++), text: f, event: "ADD" };
      }),
    });
  }
  return `echo: ${last}`;
}

const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    seen.push({ path: url.pathname, body, headers: headersOf(req.headers) });
    const model = String(body.model ?? "");
    if (url.pathname === "/openai/v1/models") return Response.json({ data: [{ id: "gpt-fake" }] });
    if (url.pathname.startsWith("/openai/") && req.headers.get("authorization") !== "Bearer sk-openai-test")
      return Response.json({ error: { message: "bad key" } }, { status: 401 });
    if (model === "fail-500") return Response.json({ error: { message: "upstream down" } }, { status: 503 });
    if (url.pathname === "/openai/v1/chat/completions") {
      const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } };
      const content = chatAnswer(body);
      if (body.stream) {
        const events: unknown[] = [
          { id: "c1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
          ...content.split(" ").map((w, i) => ({ id: "c1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: (i ? " " : "") + w } }] })),
          { id: "c1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage) events.push({ id: "c1", object: "chat.completion.chunk", model, choices: [], usage });
        events.push("data: [DONE]\n\n");
        return new Response(sseOut(events), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "c1", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage });
    }
    if (url.pathname === "/openai/v1/embeddings") {
      const input = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
      const dims = typeof body.dimensions === "number" ? body.dimensions : DIMS;
      return Response.json({
        object: "list",
        model,
        data: input.map((t, index) => ({ object: "embedding", index, embedding: vectorOf(t, dims) })),
        usage: { prompt_tokens: input.length * 10, total_tokens: input.length * 10 },
      });
    }
    if (url.pathname === "/openai/v1/images/generations") {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      return Response.json({ created: 1, data: [{ b64_json: png }] });
    }
    if (url.pathname === "/anthropic/v1/messages") {
      if (req.headers.get("x-api-key") !== "sk-ant-test") return Response.json({ type: "error", error: { message: "bad key" } }, { status: 401 });
      const usage = { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 20 };
      if (body.stream) {
        const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        return new Response(
          [
            ev("message_start", { message: { id: "m1", usage: { ...usage, output_tokens: 1 } } }),
            ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
            ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello from" } }),
            ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: " Claude" } }),
            ev("content_block_stop", { index: 0 }),
            ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }),
            ev("message_stop", {}),
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({ id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "Hello from Claude" }], stop_reason: "end_turn", usage });
    }
    return Response.json({ error: { message: `fake: no route ${url.pathname}` } }, { status: 404 });
  },
});

// ---- checks ---------------------------------------------------------------------

let failures = 0;
function check(name: string, ok: unknown, detail?: unknown) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail ?? "");
  }
}

let api = "";
let token = "";
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, key = token) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(key && { Authorization: `Bearer ${key}` }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers, text };
}
const sleep = (ms: number) => Bun.sleep(ms);

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

let apiProc: ReturnType<typeof Bun.spawn> | null = null;
try {
  await docker(
    "run",
    "-d",
    "--name",
    names[0]!,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    "POSTGRES_PASSWORD=ai-integration-only",
    "-e",
    "POSTGRES_USER=mybase",
    "-p",
    "127.0.0.1::5432",
    "mybase-postgres:dev",
  );
  await docker(
    "create",
    "--name",
    names[1]!,
    "--tmpfs",
    "/var/lib/garage",
    "-e",
    "GARAGE_RPC_SECRET=" + "ab".repeat(32),
    "-e",
    "GARAGE_ADMIN_TOKEN=ai-integration-only",
    "-p",
    "127.0.0.1::3900",
    "-p",
    "127.0.0.1::3903",
    "dxflrs/garage:v2.4.1",
  );
  await docker("cp", "docker/sandbox-test-garage.toml", `${names[1]}:/etc/garage.toml`);
  await docker("start", names[1]!);
  await docker(
    "run",
    "-d",
    "--name",
    names[2]!,
    "--tmpfs",
    "/data",
    "-p",
    "127.0.0.1::6379",
    "valkey/valkey:8.1-alpine",
    "valkey-server",
    "--requirepass",
    "ai-integration-only",
    "--save",
    "",
    "--appendonly",
    "no",
  );
  const apiPort = 47_000 + Math.floor(Math.random() * 1000);
  api = `http://127.0.0.1:${apiPort}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    API_PORT: String(apiPort),
    POSTGRES_HOST: "127.0.0.1",
    POSTGRES_PORT: String(await port(names[0]!, 5432)),
    POSTGRES_USER: "mybase",
    POSTGRES_PASSWORD: "ai-integration-only",
    GARAGE_ADMIN_URL: `http://127.0.0.1:${await port(names[1]!, 3903)}`,
    GARAGE_S3_URL: `http://127.0.0.1:${await port(names[1]!, 3900)}`,
    GARAGE_ADMIN_TOKEN: "ai-integration-only",
    GARAGE_CAPACITY: "100M",
    VALKEY_HOST: "127.0.0.1",
    VALKEY_PORT: String(await port(names[2]!, 6379)),
    VALKEY_PASSWORD: "ai-integration-only",
    MYBASE_ADMIN_PASSWORD: "ai-integration-admin",
    MYBASE_SECRETS_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    MYBASE_PUBLIC_URL: `http://127.0.0.1:${apiPort}`,
    MYBASE_AI_PRICES_REFRESH: "off",
    MYBASE_AI_BASE_OPENAI: `http://127.0.0.1:${fake.port}/openai/v1`,
    MYBASE_AI_BASE_ANTHROPIC: `http://127.0.0.1:${fake.port}/anthropic`,
    MYBASE_DB_PUBLIC: "",
    MYBASE_ADMIN_RESET_MFA: "",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
  };
  delete env.DASHBOARD_DIR;
  apiProc = Bun.spawn(["bun", "apps/api/src/index.ts"], { env, stdout: "inherit", stderr: "inherit" });
  await waitFor("the API", async () => (await fetch(`${api}/health`).catch(() => null))?.ok, 90_000);

  const login = await call("POST", "/auth/login", { username: "admin", password: "ai-integration-admin", tokenName: "ai-test" }, {}, "");
  token = login.json.token;
  check("signed in", token);
  const P = "aitest";
  check("project created", (await call("POST", "/projects", { name: P })).status < 300);

  console.log("gateway");
  const enable = await call("PUT", `/projects/${P}/services/ai`);
  check("ai enabled (secrets first)", enable.status < 300, enable.json);
  const settings = (await call("GET", `/projects/${P}/ai`)).json;
  check("settings: keys env ai, baseURL", settings.keysEnv === "ai" && settings.baseURL.endsWith(`/ai/${P}/v1`), settings);
  const missing = await call("POST", `/projects/${P}/ai/v1/chat/completions`, { model: "openai/gpt-fake", messages: [{ role: "user", content: "hi" }] });
  check("missing key → 409 naming the key", missing.status === 409 && /OPENAI_API_KEY/.test(JSON.stringify(missing.json)), missing.json);
  const keys = await call("PUT", `/projects/${P}/ai/keys`, { set: { OPENAI_API_KEY: "sk-openai-test", ANTHROPIC_API_KEY: "sk-ant-test" } });
  check("keys set through secrets", keys.status === 200 && keys.json.providers.find((p: any) => p.id === "openai").configured, keys.json);
  const envKeys = await call("GET", `/projects/${P}/secrets/envs/ai`);
  check("keys are in the secrets env ai (names, no values)", JSON.stringify(envKeys.json).includes("OPENAI_API_KEY") && !JSON.stringify(envKeys.json).includes("sk-openai-test"));

  await call("PUT", `/projects/${P}/ai/prices`, { model: "openai/gpt-fake", input: 2, output: 8, cacheRead: 0.5 });
  const app = (await call("POST", "/auth/tokens", { name: "app", permissions: ["ai:write", "vector:write", "memory:write"], projects: [P] })).json.token;
  check("app token", app);

  const chat = await call(
    "POST",
    `/ai/${P}/v1/chat/completions`,
    { model: "openai/gpt-fake", messages: [{ role: "user", content: "hello world" }], mybase: { tags: ["t1"] }, user: "u1" },
    {},
    app,
  );
  check("chat non-stream", chat.status === 200 && chat.json.choices[0].message.content === "echo: hello world", chat.json);
  check("cost header from override", Math.abs(Number(chat.headers.get("x-mybase-cost")) - (800 * 2 + 200 * 0.5 + 500 * 8) / 1e6) < 1e-9, chat.headers.get("x-mybase-cost"));
  check("upstream got the bare model and our key, not the mybase key", seen.at(-1)!.body.model === "gpt-fake" && seen.at(-1)!.headers.authorization === "Bearer sk-openai-test");

  const streamRes = await fetch(`${api}/ai/${P}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${app}` },
    body: JSON.stringify({ model: "openai/gpt-fake", stream: true, messages: [{ role: "user", content: "a b c" }] }),
  });
  const streamText = await streamRes.text();
  check(
    "stream: SSE, content, ends with [DONE]",
    streamRes.headers.get("content-type")?.includes("event-stream") && streamText.includes('"echo:"') && streamText.trim().endsWith("data: [DONE]"),
    streamText.slice(0, 300),
  );
  check("stream: usage chunk dropped (client didn't ask)", !streamText.includes('"usage"'));
  check("stream: gateway asked upstream for usage", (seen.at(-1)!.body.stream_options as any)?.include_usage === true);

  const ant = await call(
    "POST",
    `/ai/${P}/v1/chat/completions`,
    {
      model: "anthropic/claude-fake",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    },
    {},
    app,
  );
  check("anthropic translated", ant.status === 200 && ant.json.choices[0].message.content === "Hello from Claude" && ant.json.usage.prompt_tokens === 150, ant.json);
  check("anthropic got system + max_tokens", seen.at(-1)!.body.system !== undefined && typeof seen.at(-1)!.body.max_tokens === "number");
  const antStream = await (
    await fetch(`${api}/ai/${P}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${app}` },
      body: JSON.stringify({ model: "anthropic/claude-fake", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }] }),
    })
  ).text();
  check("anthropic stream → openai chunks with usage", antStream.includes("Hello from") && antStream.includes('"prompt_tokens":150'), antStream.slice(0, 400));

  const native = await fetch(`${api}/ai/${P}/native/anthropic/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": app, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-fake", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  });
  const nativeJson = (await native.json()) as any;
  check("native anthropic with x-api-key", native.status === 200 && nativeJson.content?.[0]?.text === "Hello from Claude", nativeJson);
  check("native: provider key injected, mybase key stripped", seen.at(-1)!.headers["x-api-key"] === "sk-ant-test");
  check("native path allowlist", (await call("POST", `/ai/${P}/native/anthropic/v1/files`, {}, {}, app)).status === 404);

  check("alias create", (await call("PUT", `/projects/${P}/ai/aliases/smart`, { targets: ["openai/fail-500", "anthropic/claude-fake"] })).status === 200);
  const fb = await call("POST", `/ai/${P}/v1/chat/completions`, { model: "smart", messages: [{ role: "user", content: "hi" }] }, {}, app);
  check(
    "fallback to the second target",
    fb.status === 200 && fb.headers.get("x-mybase-fallback-from") === "openai/fail-500" && fb.headers.get("x-mybase-model") === "anthropic/claude-fake",
    { status: fb.status, h: headersOf(fb.headers) },
  );

  const emb = await call("POST", `/ai/${P}/v1/embeddings`, { model: "openai/text-embedding-fake", input: ["a", "b"] }, {}, app);
  check("embeddings", emb.status === 200 && emb.json.data.length === 2, emb.json);
  const embAnt = await call("POST", `/ai/${P}/v1/embeddings`, { model: "anthropic/x", input: "a" }, {}, app);
  check("anthropic embeddings → 400 openai-shaped error", embAnt.status === 400 && typeof embAnt.json.error?.message === "string", embAnt.json);

  const c1 = await call("POST", `/ai/${P}/v1/embeddings`, { model: "openai/text-embedding-fake", input: "cache me" }, { "X-Mybase-Cache": "60" }, app);
  const c2 = await call("POST", `/ai/${P}/v1/embeddings`, { model: "openai/text-embedding-fake", input: "cache me" }, { "X-Mybase-Cache": "60" }, app);
  check("response cache hit", c1.status === 200 && c2.headers.get("x-mybase-cache") === "hit", headersOf(c2.headers));

  const img = await call("POST", `/ai/${P}/v1/images/generations`, { model: "openai/dall-e-3", prompt: "a dot", mybase: { store: "public/gen/" } }, {}, app);
  const stored = img.json.data?.[0]?.mybase;
  check("image stored in the bucket with a public URL", img.status === 200 && stored?.key?.startsWith("public/gen/") && stored.publicUrl, img.json);
  if (stored?.publicUrl) check("stored image is readable", (await fetch(stored.publicUrl)).status === 200);

  check("disallowed models", (await call("PUT", `/projects/${P}/ai`, { allowedModels: ["openai/*", "smart"] })).status === 200);
  const blocked = await call("POST", `/ai/${P}/v1/chat/completions`, { model: "anthropic/claude-fake", messages: [{ role: "user", content: "hi" }] }, {}, app);
  check("allowed_models → 403", blocked.status === 403, blocked.json);
  await call("PUT", `/projects/${P}/ai`, { allowedModels: null, captureContent: true });

  const captured = await call("POST", `/ai/${P}/v1/chat/completions`, { model: "openai/gpt-fake", messages: [{ role: "user", content: "secret prompt" }] }, {}, app);
  check("call with capture on", captured.status === 200);

  const models = await call("GET", `/ai/${P}/v1/models`, undefined, {}, app);
  check(
    "models list includes alias + configured providers",
    models.json.data.some((m: any) => m.id === "smart") && models.json.data.some((m: any) => m.id.startsWith("anthropic/")),
    models.json.data?.length,
  );

  const logs = await call("GET", `/projects/${P}/ai/logs?limit=50`);
  check("logs listed", logs.status === 200 && logs.json.logs.length >= 8, logs.json.logs?.length);
  const withContent = logs.json.logs.find((l: any) => l.hasContent);
  const detail = withContent && (await call("GET", `/projects/${P}/ai/logs/${withContent.id}`)).json;
  check("captured content decrypts", detail?.content?.request?.includes("secret prompt"), detail?.content);
  const first = logs.json.logs.find((l: any) => l.tags.includes("t1"));
  check("log row: tags, user, cost source override, key name", first?.user === "u1" && first.costSource === "override" && first.tokenName === "app", first);
  check(
    "cached row logged as cache",
    logs.json.logs.some((l: any) => l.cached && l.costSource === "cache"),
  );
  check(
    "fallback row recorded",
    logs.json.logs.some((l: any) => l.fallbackFrom === "openai/fail-500"),
  );

  const usage = await call("GET", `/projects/${P}/ai/usage?range=24h&group=model`);
  check("usage totals", usage.status === 200 && usage.json.totals.requests >= 8 && usage.json.totals.costUsd > 0, usage.json.totals);
  const byTag = await call("GET", `/projects/${P}/ai/usage?range=24h&group=tag`);
  check(
    "usage by tag",
    byTag.json.groups.some((g: any) => g.key === "t1"),
    byTag.json.groups,
  );

  await call("PUT", `/projects/${P}/ai`, { budgetUsd: 0.01, budgetHard: true });
  const over = await call("POST", `/ai/${P}/v1/chat/completions`, { model: "openai/gpt-fake", messages: [{ role: "user", content: "hi" }] }, {}, app);
  check("hard budget → 429", over.status === 429 && /budget/.test(over.json.error?.message ?? ""), over.json);
  await call("PUT", `/projects/${P}/ai`, { budgetUsd: null, budgetHard: false });
  const audited = await waitFor(
    "budget audit",
    async () => {
      const audit = await call("GET", `/audit?project=${P}&action=ai.budget_threshold`);
      return JSON.stringify(audit.json).includes("ai.budget_threshold");
    },
    20_000,
  ).catch(async () => (await call("GET", `/audit?project=${P}&limit=20`)).json);
  check("budget threshold audited", audited === true, audited);

  const sync = await call("POST", `/projects/${P}/ai/sync`, { aliases: { fast: ["openai/gpt-fake"] }, prices: { "openai/gpt-fake2": { input: 1 } } });
  check("sync aliases + prices from code", sync.json.aliases?.created?.includes("fast") && sync.json.prices?.set?.length === 1, sync.json);
  check("code alias locked on dashboard", (await call("DELETE", `/projects/${P}/ai/aliases/fast`)).status === 409);

  check(
    "custom provider (admin)",
    (await call("PUT", `/projects/${P}/ai/providers/local`, { name: "Local", baseUrl: `http://127.0.0.1:${fake.port}/openai/v1`, keyName: "OPENAI_API_KEY" })).status === 200,
  );
  const local = await call("POST", `/ai/${P}/v1/chat/completions`, { model: "local/llama", messages: [{ role: "user", content: "x" }] }, {}, app);
  check("custom provider call", local.status === 200 && local.json.choices[0].message.content === "echo: x", local.json);
  check("non-admin key can't add providers", (await call("PUT", `/projects/${P}/ai/providers/evil`, { baseUrl: "http://x" }, {}, app)).status === 403);
  check("provider test", (await call("POST", `/projects/${P}/ai/providers/openai/test`)).json.ok === true);

  console.log("vector pipeline");
  check("vector enabled", (await call("PUT", `/projects/${P}/services/vector`)).status < 300);
  const vs = await call("PUT", `/projects/${P}/vector`, { embedding: { via: "ai", model: "openai/text-embedding-fake", dimensions: DIMS } });
  check("vector embeds through the gateway", vs.status === 200 && vs.json.embedding?.via === "ai", vs.json);
  check("index", (await call("POST", `/projects/${P}/vector/indexes`, { name: "docs", embed: true })).status < 300);
  const ing = await call(
    "POST",
    `/vector/${P}/indexes/docs/ingest`,
    {
      id: "faq",
      title: "FAQ",
      chunkSize: 100,
      text: "# Reset\n\nTo reset your password open the settings page and pick a new one.\n\n# Billing\n\nInvoices are sent monthly to the billing address on file.",
    },
    {},
    app,
  );
  check("push ingest chunks", ing.status === 200 && ing.json.chunks === 2, ing.json);
  const again = await call("POST", `/vector/${P}/indexes/docs/ingest`, { id: "faq", text: "Only one chunk now." }, {}, app);
  check("re-ingest replaces old chunks", again.json.chunks === 1 && again.json.removed === 1, again.json);
  const q = await call("POST", `/vector/${P}/indexes/docs/query`, { text: "one chunk", topK: 3 }, {}, app);
  check("query finds ingested chunk", q.json.matches?.[0]?.id === "faq#0", q.json);

  const md = "# Guide\n\nInstall with bun, then log in to your server with the CLI.\n\n# Usage\n\nRun mybase deploy from the app directory to ship it.";
  const up = await fetch(`${api}/projects/${P}/files/docs/guide.md`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" }, body: md });
  check("uploaded a file", up.status < 300, up.status);
  const src = await call("PUT", `/projects/${P}/vector/indexes/docs/sources/files`, {
    kind: "storage",
    config: { prefix: "docs/" },
    intervalMin: 0,
    chunkSize: 100,
    chunkOverlap: 20,
  });
  check("storage source created", src.status === 200, src.json);
  const synced = await waitFor("storage sync", async () => {
    const list = (await call("GET", `/projects/${P}/vector/indexes/docs/sources`)).json as any[];
    const s = list.find((x) => x.id === "files");
    return s?.status === "idle" && s.lastSyncAt ? s : s?.status === "error" ? s : null;
  });
  check("storage source synced", synced.status === "idle" && synced.items === 1 && synced.chunks === 2, synced);
  await fetch(`${api}/projects/${P}/files/docs/guide.md`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  await call("POST", `/vector/${P}/indexes/docs/sources/files/sync`, {}, {}, app);
  const afterDelete = await waitFor("resync", async () => {
    const s = ((await call("GET", `/projects/${P}/vector/indexes/docs/sources`)).json as any[]).find((x) => x.id === "files");
    return s?.status === "idle" && s.items === 0 ? s : null;
  });
  check("deleted file's chunks removed", afterDelete.chunks === 0, afterDelete);
  const vlogs = await call("GET", `/projects/${P}/ai/logs?tag=vector`);
  check("vector embeddings logged in the gateway under tag vector", vlogs.json.logs.length > 0);

  console.log("memory");
  const me = await call("PUT", `/projects/${P}/services/memory`);
  check("memory enabled", me.status < 300, me.json);
  const ms = await call("PUT", `/projects/${P}/memory`, { llmModel: "openai/gpt-fake", embedModel: "openai/text-embedding-fake", dimensions: DIMS });
  check("memory settings (dims changed while empty)", ms.status === 200 && ms.json.dimensions === DIMS, ms.json);
  const add1 = await call("POST", `/memory/${P}/memories`, { userId: "u42", messages: [{ role: "user", content: "Is vegetarian and Lives in Lisbon" }] }, {}, app);
  check("add: two facts added", add1.status === 201 && add1.json.results.filter((r: any) => r.event === "ADD").length === 2, add1.json);
  const add2 = await call("POST", `/memory/${P}/memories`, { userId: "u42", messages: [{ role: "user", content: "Is vegetarian and Lives in Porto" }] }, {}, app);
  check(
    "add: known fact unchanged, moved city updated",
    add2.json.results.length === 1 && add2.json.results[0].event === "UPDATE" && add2.json.results[0].previous === "Lives in Lisbon",
    add2.json,
  );
  const search = await call("POST", `/memory/${P}/search`, { userId: "u42", query: "Porto" }, {}, app);
  check("search", search.status === 200 && search.json.results.some((r: any) => r.memory === "Lives in Porto"), search.json);
  const other = await call("POST", `/memory/${P}/search`, { userId: "someone-else", query: "Porto" }, {}, app);
  check("scope isolation", other.json.results.length === 0, other.json);
  const hist = await call("GET", `/memory/${P}/memories/${add2.json.results[0].id}/history`, undefined, {}, app);
  check("history ADD then UPDATE", hist.json.map((h: any) => h.event).join(",") === "ADD,UPDATE", hist.json);
  const raw = await call("POST", `/memory/${P}/memories`, { agentId: "bot", text: "Remember the deploy runs at 9", infer: false }, {}, app);
  check("infer false stores text as is", raw.json.results[0]?.memory === "Remember the deploy runs at 9", raw.json);
  const del = await call("POST", `/memory/${P}/memories/delete`, { userId: "u42" }, {}, app);
  check("deleteAll by scope", del.json.deleted === 2, del.json);
  const mlogs = await call("GET", `/projects/${P}/ai/logs?tag=memory`);
  check("memory LLM calls logged under tag memory", mlogs.json.logs.length >= 4, mlogs.json.logs.length);
  const ctx = await call("GET", `/projects/${P}/context`);
  check("context has ai + memory sections, no key values", ctx.json.ai?.baseURL && ctx.json.memory && !JSON.stringify(ctx.json).includes("sk-openai-test"), ctx.json.ai);

  if (process.env.AI_TEST_KEEP) {
    // Leaves the stack up for poking at the dashboard: API_PORT=<port> bun run dev:dashboard.
    console.log(`kept running: API ${api}, admin / ai-integration-admin, project ${P}. Ctrl-C to clean up.`);
    await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
  }
    check("disable order: memory before ai", (await call("DELETE", `/projects/${P}/services/ai`)).status === 409);
  check("memory off", (await call("DELETE", `/projects/${P}/services/memory`)).status < 300);
  check("ai off", (await call("DELETE", `/projects/${P}/services/ai`)).status < 300);
  check("project deleted", (await call("DELETE", `/projects/${P}?yes=true`)).status < 300);
} finally {
  apiProc?.kill();
  fake.stop(true);
  for (const name of names) await docker("rm", "-f", name).catch(() => {});
}
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
