# Define jobs in code

Use `defineConfig` to declare schedules in `mybase.config.ts` at your app root. The CLI imports this file when syncing, so keep application code and secrets out of it; handlers belong in your HTTP endpoint.

## Declare jobs

```ts
// mybase.config.ts
import { defineConfig } from "@mybase-dev/sdk/config";

export default defineConfig({
  project: "shop",
  cron: {
    baseUrl: "https://shop.example.com",
    jobs: {
      cleanup: { schedule: "0 3 * * *" },
      digest: {
        schedule: "0 8 * * 1",
        timezone: "America/Chicago",
        path: "/api/cron",
        payload: { kind: "weekly" },
      },
    },
  },
});
```

`baseUrl` must be reachable from the mybase server. The default path is `/api/cron`. Schedules have five fields (minute precision); the default time zone is `UTC`.

## Sync with mybase

```sh
mybase cron sync --dry-run
mybase cron sync
```

Sync creates, updates, and deletes **code-defined** jobs to match the file. It never changes jobs created in the dashboard.

## Job options

| Job option | Default | Meaning |
| --- | --- | --- |
| `schedule` | required | Five-field cron expression |
| `path` | `/api/cron` | Appended to `baseUrl` |
| `timezone` | `UTC` | IANA time zone |
| `payload` | none | JSON sent to the handler, up to 16 KB |
| `retries` | `2` | Extra tries, 0–5 |
| `timeoutMs` | `30000` | Per-call timeout, 1000–120000 ms |

## Typed handlers

For typed job names in a handler, import the config type and call `cronHandler<typeof config>({ ... })`. See [handling cron calls](cron-handler.md).
