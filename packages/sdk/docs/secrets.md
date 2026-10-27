# Secrets

Read your app's env vars and secrets from mybase at runtime. Most apps don't need this: `mybase run -- <command>` starts the app with them as env vars. Use the client when the app should pick up a changed value without a restart, or where you can't wrap the start command.

Turn secrets on from the project's page or with `mybase secrets enable <project>`. Your server authenticates with a mybase API key that has `secrets:read` for the project, ideally limited to one environment: `mybase token create shop-prod --project shop --env prod --perm secrets:read`. Keep it server-side, as `MYBASE_API_KEY`.

## Read

```ts
import { createSecretsClient } from "@mybase-dev/sdk/secrets";

const secrets = createSecretsClient({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  env: "prod",
  apiKey: process.env.MYBASE_API_KEY!,
});

await secrets.load(); // copies every key into process.env; vars already set win
const stripeKey = await secrets.get("STRIPE_SECRET_KEY"); // undefined when unset
const all = await secrets.all(); // { KEY: "value", … }, branch envs include inherited keys
```

`load({ override: true })` replaces vars that are already set. It returns the keys it set.

Every read asks mybase with the last ETag, so a read where nothing changed is a 304 with no body. Set `maxAgeMs` to reuse values for a while without asking at all:

```ts
const secrets = createSecretsClient({ /* … */, maxAgeMs: 60_000 });
```

## Write

With `secrets:write`, apps and scripts can change values. Each call is one revision in the history.

```ts
await secrets.set({ FEATURE_X: "on" }, { message: "turn on feature x" });
await secrets.unset(["OLD_KEY"]);
```

Keys written by `mybase secrets link` (the project's own credentials) can't be changed this way (409).

## Errors

Failed calls throw `MybaseApiError` with the HTTP `status`: 401 bad key, 403 the key can't read that project or env, 404 secrets are off or the env doesn't exist, 503 the server has no `MYBASE_SECRETS_KEY`. There is no fallback: decide in your app whether to start without secrets.

## Options

| Option | Default | |
|---|---|---|
| `apiUrl` | | Where your app reaches mybase |
| `project`, `env` | | Which env to read |
| `apiKey` | | `mb_…` with `secrets:read` (`secrets:write` for `set`/`unset`) |
| `maxAgeMs` | `0` | Reuse fetched values this long without asking |
| `timeoutMs` | `10000` | Per request |
| `fetch` | `globalThis.fetch` | |
